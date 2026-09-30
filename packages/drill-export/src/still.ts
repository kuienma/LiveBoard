import { compileVariant, sampleTimeline, type TrailFrame } from '@drill/engine'
import { CJK_FONT_STACK, computeLayout, drawFrame } from '@drill/render'
import type { Drill, Vec2 } from '@drill/schema'
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { EXPORT_SIZES, type Orientation } from './frames.js'

const BACKGROUND = '#0a0a0a'

export interface StillOptions {
  orientation: Orientation
  /** 在角上标练法名，默认标：静态图往往要单独发给别人看。 */
  showVariantLabel?: boolean
}

/**
 * 一个练法一张静态图：球员画在起始站位，路线画成完整第一轮的虚线 + 箭头。
 *
 * 为什么是「第一轮」：后面几轮只是重复或轮换，路线形状一样，叠在一起反而看不清。
 * 为什么不直接取某一帧：帧里的 trails 只有当前阶段那一段，
 * 而教练要的是「从哪儿跑到哪儿」的全程。
 */
export function renderStillPng(drill: Drill, variantId: string, options: StillOptions): Buffer {
  const variant = drill.variants.find((item) => item.id === variantId)
  if (variant === undefined) throw new Error(`找不到练法「${variantId}」`)

  const timeline = compileVariant(drill, variantId)
  const { width, height } = EXPORT_SIZES[options.orientation]
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = BACKGROUND
  ctx.fillRect(0, 0, width, height)

  const trails = buildRoundTrails(timeline)
  // 起始站位那一帧 + 全程路线：说明条留着，它写的是第一阶段在做什么
  const frame = { ...sampleTimeline(timeline, 0), trails }
  drawFrame(ctx, frame, { width, height })

  // 箭头单独画在这里，不塞进 drill-render：播放时每一帧末端都挂个箭头会很吵
  const layout = computeLayout(frame, { width, height })
  const roleById = new Map(frame.actors.map((actor) => [actor.id, actor.role]))
  for (const trail of trails) {
    drawArrowHead(ctx, trail, layout.toPx, layout.scale, roleById.get(trail.actorId) ?? 'neutral')
  }

  if (options.showVariantLabel ?? true) drawCaption(ctx, variant.name, width, height)

  return canvas.toBuffer('image/png')
}

/**
 * 取第一轮全程的路线，每人可能有多段（带球和无球跑动线形不同）。
 *
 * 直接读时间线的分段，而不是按时间采样球员位置：
 * 分段里的 points 已经是平滑后的密集折线，采样只会更粗糙，
 * 而且采样拿不到「这段是不是带球」这个信息。
 */
function buildRoundTrails(timeline: ReturnType<typeof compileVariant>): TrailFrame[] {
  const trails: TrailFrame[] = []

  for (const segment of timeline.segments) {
    if (segment.roundIndex !== 0) continue

    for (const motion of segment.actors) {
      if (!motion.moving || motion.points.length < 2) continue

      // 同一个人、同样带球状态、首尾相接就接上，让线形连续
      const last = trails.at(-1)
      const joins =
        last !== undefined &&
        last.actorId === motion.actorId &&
        last.withBall === motion.withBall &&
        samePoint(last.points.at(-1), motion.points[0])

      if (joins) last.points.push(...motion.points.slice(1))
      else
        trails.push({
          actorId: motion.actorId,
          points: [...motion.points],
          withBall: motion.withBall,
        })
    }
  }

  return trails
}

function samePoint(a: Vec2 | undefined, b: Vec2 | undefined): boolean {
  if (a === undefined || b === undefined) return false
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

const ARROW_COLOR: Record<string, string> = {
  attacker: '#f87171',
  defender: '#93c5fd',
  coach: '#93c5fd',
  neutral: '#e5e5e5',
}

function drawArrowHead(
  ctx: SKRSContext2D,
  trail: TrailFrame,
  toPx: (pos: Vec2) => Vec2,
  scale: number,
  role: string,
): void {
  // 箭头画在离起点最远的那个点：单程路线就是终点，
  // 往返路线（跑出去再回来）则落在折返处——画在真正的终点会被球员圆点盖住
  const start = trail.points[0]
  if (start === undefined || trail.points.length < 2) return
  let farIndex = 1
  for (let i = 1; i < trail.points.length; i++) {
    if (distance(start, trail.points[i]!) > distance(start, trail.points[farIndex]!)) farIndex = i
  }
  const end = trail.points[farIndex]
  const before = trail.points[farIndex - 1]
  if (end === undefined || before === undefined) return

  const [x, y] = toPx(end)
  const [px, py] = toPx(before)
  const angle = Math.atan2(y - py, x - px)
  const size = Math.max(8, 0.5 * scale)

  ctx.save()
  ctx.fillStyle = ARROW_COLOR[role] ?? ARROW_COLOR['neutral']!
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size * Math.cos(angle - 0.4), y - size * Math.sin(angle - 0.4))
  ctx.lineTo(x - size * Math.cos(angle + 0.4), y - size * Math.sin(angle + 0.4))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** 练法名放在底部：静态图常常是单独发出去的，得自带标题。 */
function drawCaption(ctx: SKRSContext2D, name: string, width: number, height: number): void {
  const fontSize = Math.round(width / 40)
  const pad = Math.round(fontSize * 0.45)
  ctx.save()
  // 必须用共享的中文字体栈：sans-serif 在只装了繁体字体的系统上会把「练」画成方框
  ctx.font = `600 ${fontSize}px ${CJK_FONT_STACK}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  const textWidth = ctx.measureText(name).width
  const baseline = height - fontSize * 0.7
  // 底部压在草地上，垫一层半透明底才看得清
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
  ctx.fillRect(
    width / 2 - textWidth / 2 - pad * 1.5,
    baseline - fontSize - pad * 0.6,
    textWidth + pad * 3,
    fontSize + pad * 1.4,
  )
  ctx.fillStyle = '#ffffff'
  ctx.fillText(name, width / 2, baseline)
  ctx.restore()
}
