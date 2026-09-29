import { compileVariant, sampleTimeline } from '@drill/engine'
import { drawFrame } from '@drill/render'
import type { Drill } from '@drill/schema'

const WIDTH = 320
const HEIGHT = 240
const JPEG_QUALITY = 0.72

/**
 * 给训练库列表画一张缩略图。
 *
 * 直接复用播放器的 drawFrame 取第一个练法的起始站位，所以缩略图和实际画面一致，
 * 不需要等阶段四的 Playwright 服务端渲染。
 * 关掉说明条和跑动虚线：列表里那么小，只要看清布局就够了。
 */
export function renderThumbnail(drill: Drill): string | undefined {
  const variant = drill.variants[0]
  if (variant === undefined) return undefined

  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (ctx === null) return undefined

  try {
    const frame = sampleTimeline(compileVariant(drill, variant.id), 0)
    drawFrame(
      ctx,
      frame,
      { width: WIDTH, height: HEIGHT },
      { showNarration: false, showTrails: false, showSlowMotionBadge: false },
    )
    // JPEG 而不是 PNG：缩略图要进数据库（上限 200KB），JPEG 体积可预期
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } catch {
    // 缩略图画不出来不该挡住保存
    return undefined
  }
}
