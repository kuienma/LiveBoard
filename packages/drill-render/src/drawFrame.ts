import type { ActorFrame, FrameState, TurnHighlightFrame } from '@drill/engine'
import type { DrillObject, Vec2 } from '@drill/schema'
import { CJK_FONT_STACK, objectColors, theme } from './theme.js'

/**
 * 作图需要的 Canvas 2D 子集。
 *
 * 刻意不直接用 CanvasRenderingContext2D：服务端导出走 @napi-rs/canvas，
 * 它没有 drawFocusIfNeeded 这类只在 DOM 里有意义的成员。
 * 收窄到真正用到的能力，两端就能传同一个 drawFrame，不必在调用处硬转类型。
 */
export type DrawContext = Omit<CanvasRenderingContext2D, DomOnlyMembers>

/** 这些成员 drawFrame 用不到，且两端签名不同（入参是 DOM 元素或返回 DOM 类型）。 */
type DomOnlyMembers =
  | 'canvas'
  | 'drawFocusIfNeeded'
  | 'drawImage'
  | 'createPattern'
  | 'createImageData'
  | 'getImageData'
  | 'putImageData'
  | 'getTransform'
  | 'setTransform'

export interface Viewport {
  /** 逻辑宽高（CSS 像素）。调用方负责按 devicePixelRatio 预先缩放 ctx。 */
  width: number
  height: number
}

export interface RenderOptions {
  /** 画当前轮次的跑动虚线。 */
  showTrails?: boolean
  /** 顶部显示当前轮次说明。 */
  showNarration?: boolean
  /** 慢放时显示「慢放」角标。 */
  showSlowMotionBadge?: boolean
}

/** 场地米制坐标 → 画布像素坐标的映射。 */
export interface Layout {
  scale: number
  offsetX: number
  offsetY: number
  /** 说明条高度（0 表示不显示）。 */
  bandHeight: number
  /** 说明条顶边的 y。 */
  bandTop: number
  toPx: (pos: Vec2) => Vec2
  /** 画布像素 → 场地米制，编辑器拖拽会用到。 */
  toField: (px: Vec2) => Vec2
}

const PADDING = 8

/**
 * 计算场地在画布中的摆放：等比缩放放进去，顶部给说明文字留一条。
 * 单独导出是为了让编辑器能把手指坐标换算回米。
 */
export function computeLayout(
  frame: FrameState,
  viewport: Viewport,
  options: RenderOptions = {},
): Layout {
  const bandHeight = narrationBandHeight(frame, viewport, options)
  const availableWidth = Math.max(1, viewport.width - PADDING * 2)
  const availableHeight = Math.max(1, viewport.height - bandHeight - PADDING * 2)

  const scale = Math.min(
    availableWidth / frame.field.width,
    availableHeight / frame.field.height,
  )
  const pitchHeight = frame.field.height * scale
  // 说明条 + 场地作为一个整体垂直居中，说明条紧贴场地上沿，
  // 这样竖屏的富余空间落在整块的上下，而不是夹在文字和场地之间
  const blockTop = Math.max(0, (viewport.height - (bandHeight + pitchHeight)) / 2)
  const offsetX = (viewport.width - frame.field.width * scale) / 2
  const offsetY = blockTop + bandHeight

  return {
    scale,
    offsetX,
    offsetY,
    bandHeight,
    bandTop: blockTop,
    toPx: ([x, y]) => [offsetX + x * scale, offsetY + y * scale],
    toField: ([px, py]) => [(px - offsetX) / scale, (py - offsetY) / scale],
  }
}

/**
 * 把一帧画到 Canvas 2D 上。同步完成，返回时像素已经落定——
 * 服务端 Playwright 逐帧截图就是靠这一点保证不会截到画了一半的画面。
 *
 * 纯绘制：不读时钟、不做动画、不碰 DOM，同样的 frame 永远画出同样的像素。
 */
export function drawFrame(
  ctx: DrawContext,
  frame: FrameState,
  viewport: Viewport,
  options: RenderOptions = {},
): void {
  const {
    showTrails = true,
    showNarration = true,
    showSlowMotionBadge = true,
  } = options
  const layout = computeLayout(frame, viewport, options)

  ctx.save()
  ctx.clearRect(0, 0, viewport.width, viewport.height)

  drawBackground(ctx, frame, viewport, layout)
  if (frame.field.boundary) drawBoundary(ctx, frame, layout)
  if (showTrails) drawTrails(ctx, frame, layout)
  for (const object of frame.objects) drawObject(ctx, object, layout)
  for (const actor of frame.actors) drawActor(ctx, actor, layout)
  // 高亮弧画在球员之后：它的半径贴着圆点外沿，先画会被圆点盖住
  if (frame.turnHighlight !== undefined) drawTurnHighlight(ctx, frame.turnHighlight, layout)
  for (const ball of frame.balls) drawBall(ctx, ball.pos, layout)
  if (showNarration) drawNarration(ctx, frame, layout)
  if (showSlowMotionBadge && frame.slowMotion) drawSlowMotionBadge(ctx, frame, layout)

  ctx.restore()
}

function narrationBandHeight(
  frame: FrameState,
  viewport: Viewport,
  options: RenderOptions,
): number {
  if (options.showNarration === false || frame.narration === '') return 0
  // 同时看宽和高：横屏画布很矮时说明条要跟着变薄，否则场地会被挤没
  const byWidth = viewport.width * 0.14
  const byHeight = viewport.height * 0.18
  return Math.round(Math.max(28, Math.min(70, Math.min(byWidth, byHeight))))
}

function drawBackground(
  ctx: DrawContext,
  frame: FrameState,
  viewport: Viewport,
  layout: Layout,
): void {
  ctx.fillStyle = theme.canvasBackground
  ctx.fillRect(0, 0, viewport.width, viewport.height)

  const [x0, y0] = layout.toPx([0, 0])
  const width = frame.field.width * layout.scale
  const height = frame.field.height * layout.scale

  if (frame.field.style === 'board') {
    ctx.fillStyle = theme.boardBackground
    ctx.fillRect(x0, y0, width, height)
    return
  }

  ctx.fillStyle = theme.pitch
  ctx.fillRect(x0, y0, width, height)

  // 割草条纹：每 2 米一条，交替深浅
  ctx.save()
  ctx.beginPath()
  ctx.rect(x0, y0, width, height)
  ctx.clip()
  ctx.fillStyle = theme.pitchStripe
  const stripeMeters = 2
  for (let y = 0; y < frame.field.height; y += stripeMeters * 2) {
    const top = layout.toPx([0, y])[1]
    ctx.fillRect(x0, top, width, stripeMeters * layout.scale)
  }
  ctx.restore()
}

function drawBoundary(ctx: DrawContext, frame: FrameState, layout: Layout): void {
  const [x0, y0] = layout.toPx([0, 0])
  ctx.strokeStyle = theme.line
  ctx.lineWidth = Math.max(1, theme.size.lineWidth * layout.scale)
  ctx.strokeRect(
    x0,
    y0,
    frame.field.width * layout.scale,
    frame.field.height * layout.scale,
  )
}

function drawTrails(ctx: DrawContext, frame: FrameState, layout: Layout): void {
  const roleById = new Map(frame.actors.map((a) => [a.id, a.role]))

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1.5, theme.size.trailWidth * layout.scale)
  const dash = Math.max(3, 0.32 * layout.scale)
  ctx.setLineDash([dash, dash * 0.8])

  for (const trail of frame.trails) {
    if (trail.points.length < 2) continue
    const role = roleById.get(trail.actorId) ?? 'neutral'
    ctx.strokeStyle = theme.trail[role]

    ctx.beginPath()
    const [startX, startY] = layout.toPx(trail.points[0]!)
    ctx.moveTo(startX, startY)
    for (let i = 1; i < trail.points.length; i++) {
      const [px, py] = layout.toPx(trail.points[i]!)
      ctx.lineTo(px, py)
    }
    ctx.stroke()
  }

  ctx.restore()
}

/** 转身高亮：沿球绕行的半圆画一段带箭头的弧，指明往哪边转。 */
function drawTurnHighlight(
  ctx: DrawContext,
  highlight: TurnHighlightFrame,
  layout: Layout,
): void {
  const [cx, cy] = layout.toPx(highlight.center)
  const radius = highlight.radius * layout.scale
  const from = (highlight.fromFacing * Math.PI) / 180
  const to = (highlight.currentFacing * Math.PI) / 180
  const counterClockwise = highlight.direction === -1

  ctx.save()
  ctx.strokeStyle = theme.turnHighlight
  ctx.lineWidth = Math.max(2, 0.1 * layout.scale)
  ctx.lineCap = 'round'
  ctx.setLineDash([])

  ctx.beginPath()
  ctx.arc(cx, cy, radius, from, to, counterClockwise)
  ctx.stroke()

  // 箭头画在当前端点，朝着转动的切线方向
  const tangent = to + (counterClockwise ? -Math.PI / 2 : Math.PI / 2)
  const tipX = cx + Math.cos(to) * radius
  const tipY = cy + Math.sin(to) * radius
  const headSize = Math.max(4, 0.2 * layout.scale)

  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(
    tipX - Math.cos(tangent - 0.5) * headSize,
    tipY - Math.sin(tangent - 0.5) * headSize,
  )
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(
    tipX - Math.cos(tangent + 0.5) * headSize,
    tipY - Math.sin(tangent + 0.5) * headSize,
  )
  ctx.stroke()
  ctx.restore()
}

function drawObject(ctx: DrawContext, object: DrillObject, layout: Layout): void {
  const color = objectColors[object.color]
  const [px, py] = layout.toPx(object.pos)

  switch (object.type) {
    case 'cone': {
      const height =
        (object.size === 'tall' ? theme.size.coneTall : theme.size.coneShort) * layout.scale
      const halfWidth = height * 0.5
      ctx.save()
      ctx.fillStyle = color
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)'
      ctx.lineWidth = Math.max(1, layout.scale * 0.03)
      ctx.beginPath()
      ctx.moveTo(px, py - height * 0.62)
      ctx.lineTo(px + halfWidth, py + height * 0.38)
      ctx.lineTo(px - halfWidth, py + height * 0.38)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
      break
    }
    case 'disc': {
      const radius = 0.22 * layout.scale
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.ellipse(px, py, radius, radius * 0.5, 0, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'pole': {
      const height = 1.4 * layout.scale
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(2, 0.1 * layout.scale)
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(px, py - height)
      ctx.stroke()
      break
    }
    case 'goal': {
      const width = 3 * layout.scale
      const depth = 0.8 * layout.scale
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(2, 0.08 * layout.scale)
      ctx.strokeRect(px - width / 2, py - depth / 2, width, depth)
      break
    }
  }
}

function drawActor(ctx: DrawContext, actor: ActorFrame, layout: Layout): void {
  const palette = theme.actor[actor.role]
  const [px, py] = layout.toPx(actor.pos)
  const radius = theme.size.actorRadius * layout.scale

  ctx.save()

  // 朝向小三角，方便看出转身
  const rad = (actor.facing * Math.PI) / 180
  const tip = radius * 1.45
  ctx.fillStyle = palette.fill
  ctx.globalAlpha = 0.85
  ctx.beginPath()
  ctx.moveTo(px + Math.cos(rad) * tip, py + Math.sin(rad) * tip)
  ctx.lineTo(
    px + Math.cos(rad + 2.5) * radius * 0.85,
    py + Math.sin(rad + 2.5) * radius * 0.85,
  )
  ctx.lineTo(
    px + Math.cos(rad - 2.5) * radius * 0.85,
    py + Math.sin(rad - 2.5) * radius * 0.85,
  )
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1

  ctx.fillStyle = palette.fill
  ctx.strokeStyle = palette.ring
  ctx.lineWidth = Math.max(1, radius * 0.14)
  ctx.beginPath()
  ctx.arc(px, py, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  const label = actor.label ?? (actor.role === 'coach' ? '教' : '')
  if (label !== '') {
    ctx.fillStyle = palette.text
    ctx.font = `600 ${Math.max(9, radius * 1.15)}px ${CJK_FONT_STACK}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, px, py + radius * 0.04)
  }

  ctx.restore()
}

function drawBall(ctx: DrawContext, pos: Vec2, layout: Layout): void {
  const [px, py] = layout.toPx(pos)
  const radius = Math.max(2.5, theme.size.ballRadius * layout.scale)

  ctx.save()
  ctx.fillStyle = theme.ball
  ctx.strokeStyle = theme.ballOutline
  ctx.lineWidth = Math.max(1, radius * 0.32)
  ctx.beginPath()
  ctx.arc(px, py, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function drawNarration(
  ctx: DrawContext,
  frame: FrameState,
  layout: Layout,
): void {
  if (layout.bandHeight === 0) return

  const left = layout.offsetX
  const width = frame.field.width * layout.scale
  const radius = Math.min(10, layout.bandHeight / 2)

  ctx.save()
  ctx.fillStyle = theme.narrationBackground
  roundRect(ctx, left, layout.bandTop, width, layout.bandHeight, radius)
  ctx.fill()

  ctx.fillStyle = theme.narrationText
  const fontSize = Math.round(Math.max(12, Math.min(22, layout.bandHeight * 0.44)))
  ctx.font = `600 ${fontSize}px ${CJK_FONT_STACK}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(
    frame.narration,
    left + width / 2,
    layout.bandTop + layout.bandHeight / 2,
    width - 16,
  )
  ctx.restore()
}

function drawSlowMotionBadge(
  ctx: DrawContext,
  frame: FrameState,
  layout: Layout,
): void {
  const text = '慢放'
  const fontSize = Math.round(Math.max(11, Math.min(16, layout.scale * 0.5)))

  ctx.save()
  ctx.font = `600 ${fontSize}px ${CJK_FONT_STACK}`
  const paddingX = fontSize * 0.6
  const width = ctx.measureText(text).width + paddingX * 2
  const height = fontSize * 1.9
  // 贴在场地右上角内侧
  const x = layout.offsetX + frame.field.width * layout.scale - width - 8
  const y = layout.offsetY + 8

  ctx.fillStyle = theme.badgeBackground
  roundRect(ctx, x, y, width, height, height / 2)
  ctx.fill()

  ctx.fillStyle = theme.badgeText
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + width / 2, y + height / 2)
  ctx.restore()
}

function roundRect(
  ctx: DrawContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
}
