import { compileVariant, sampleTimeline, type Timeline } from '@drill/engine'
import { CJK_FONT_STACK, drawFrame } from '@drill/render'
import type { Drill } from '@drill/schema'
import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'

/** 竖屏/横屏两种画布尺寸，对应验收里的 1080p。 */
export const EXPORT_SIZES = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
} as const

export type Orientation = keyof typeof EXPORT_SIZES

/** 固定 30fps：验收要求，也是剪映最省事的帧率。 */
export const EXPORT_FPS = 30

/**
 * 画面背景。播放器页面是深色底，导出时画布外围也填同一个颜色，
 * 否则透明区域转成 yuv420 会变成纯黑，和预览对不上。
 */
const BACKGROUND = '#0a0a0a'

export interface RenderOptions {
  orientation: Orientation
  /** 是否画说明条（和播放器一致，默认画）。 */
  showNarration?: boolean
  /** 多个练法导出到一个文件时，在角上标出当前是哪个练法。 */
  variantLabel?: string
}

export interface VariantPlan {
  variantId: string
  name: string
  timeline: Timeline
  frameCount: number
}

/**
 * 算出每个练法要出多少帧。
 *
 * 单独抽出来是为了让进度条在开始渲染前就知道总帧数——
 * 不然只能显示「正在导出」这种没用的状态。
 */
export function planVariants(drill: Drill, variantIds: readonly string[]): VariantPlan[] {
  return variantIds.map((variantId) => {
    const variant = drill.variants.find((item) => item.id === variantId)
    if (variant === undefined) throw new Error(`找不到练法「${variantId}」`)
    const timeline = compileVariant(drill, variantId)
    return {
      variantId,
      name: variant.name,
      timeline,
      // 末帧包含在内：时长 2s、30fps 出 60 帧（t = 0 .. 59/30）
      frameCount: Math.max(1, Math.round(timeline.duration * EXPORT_FPS)),
    }
  })
}

export interface FrameRenderer {
  canvas: Canvas
  /** 把第 index 帧画到画布上，index 从 0 开始。 */
  draw: (plan: VariantPlan, index: number, options: RenderOptions) => void
}

export function createRenderer(orientation: Orientation): FrameRenderer {
  const { width, height } = EXPORT_SIZES[orientation]
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  return {
    canvas,
    draw: (plan, index, options) => {
      ctx.save()
      ctx.fillStyle = BACKGROUND
      ctx.fillRect(0, 0, width, height)
      ctx.restore()

      const frame = sampleTimeline(plan.timeline, index / EXPORT_FPS)
      // 和播放器同一个纯函数，画面一致靠共享代码保证，而不是靠截图
      drawFrame(ctx, frame, { width, height }, { showNarration: options.showNarration ?? true })

      if (options.variantLabel !== undefined) drawVariantLabel(ctx, options.variantLabel, width)
    },
  }
}

/** 练法名画在右上角，只在一次导出包含多个练法时用。 */
function drawVariantLabel(ctx: SKRSContext2D, label: string, width: number): void {
  const fontSize = Math.round(width / 48)
  const padding = Math.round(fontSize * 0.7)
  ctx.save()
  ctx.font = `600 ${fontSize}px ${CJK_FONT_STACK}`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  const textWidth = ctx.measureText(label).width
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.fillRect(
    width - textWidth - padding * 3,
    padding,
    textWidth + padding * 2,
    fontSize + padding,
  )
  ctx.fillStyle = '#ffffff'
  ctx.fillText(label, width - padding * 2, padding + padding / 2)
  ctx.restore()
}

/**
 * 列出系统里能画中文的字体。
 *
 * macOS 上系统字体会被自动识别，但精简的 Docker 镜像里往往一个中文字体都没有，
 * 那时说明文字会变成方框——宁愿在启动日志里明说，也不要导出一堆废视频。
 *
 * 返回全部而不是第一个：第一个可能是繁体字体（如 Heiti TC，没有「练」字），
 * 只报它会让人以为万事大吉，实际靠的是字体栈里的后备字体逐字兜底。
 */
export function findCjkFonts(): string[] {
  return GlobalFonts.families
    .filter((family) =>
      /PingFang|Heiti|Hiragino|Songti|Noto Sans CJK|Noto Sans SC|Source Han|WenQuanYi|Microsoft YaHei|SimHei/i.test(
        family.family,
      ),
    )
    .map((family) => family.family)
}

/** 注册额外的字体文件（Docker 里用 DRILL_EXPORT_FONT 指一个中文字体）。 */
export function registerFont(path: string): boolean {
  return GlobalFonts.registerFromPath(path) !== null
}
