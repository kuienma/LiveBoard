import { compileVariant, sampleTimeline, type FrameState } from '@drill/engine'
import { parseDrill } from '@drill/schema'
import { beforeAll, describe, expect, it } from 'vitest'
import raw from '../../../fixtures/side-attack.json'
import { computeLayout } from './drawFrame.js'

let frame: FrameState

beforeAll(() => {
  const result = parseDrill(raw)
  if (!result.ok) throw new Error('示例数据未通过校验')
  frame = sampleTimeline(compileVariant(result.drill, 'basic'), 0)
})

describe('场地在画布中的摆放', () => {
  it('等比缩放，不会把 20×15 的场地拉变形', () => {
    const layout = computeLayout(frame, { width: 800, height: 400 })
    const [x0, y0] = layout.toPx([0, 0])
    const [x1, y1] = layout.toPx([20, 15])
    expect((x1 - x0) / (y1 - y0)).toBeCloseTo(20 / 15, 6)
  })

  it('横向富余时场地水平居中', () => {
    const layout = computeLayout(frame, { width: 1000, height: 300 })
    const [left] = layout.toPx([0, 0])
    const [right] = layout.toPx([20, 0])
    expect(left).toBeCloseTo(1000 - right, 6)
  })

  it('竖屏时场地占满宽度', () => {
    const layout = computeLayout(frame, { width: 375, height: 700 }, { showNarration: false })
    const [left] = layout.toPx([0, 0])
    const [right] = layout.toPx([20, 0])
    expect(left).toBeCloseTo(8, 6) // 只剩 8px 留白
    expect(right).toBeCloseTo(367, 6)
  })

  it('有顶部说明时场地整体下移，不会被文字压住', () => {
    const withBand = computeLayout(frame, { width: 375, height: 700 }, { showNarration: true })
    const without = computeLayout(frame, { width: 375, height: 700 }, { showNarration: false })
    expect(withBand.toPx([0, 0])[1]).toBeGreaterThan(without.toPx([0, 0])[1])
  })

  it('像素与米制可以互相换算（编辑器拖拽依赖）', () => {
    const layout = computeLayout(frame, { width: 390, height: 844 })
    for (const point of [[0, 0], [10, 7.5], [20, 15], [4, 3]] as [number, number][]) {
      const [x, y] = layout.toField(layout.toPx(point))
      expect(x).toBeCloseTo(point[0], 6)
      expect(y).toBeCloseTo(point[1], 6)
    }
  })

  it('画布极小也不会算出非法数值', () => {
    const layout = computeLayout(frame, { width: 1, height: 1 })
    expect(Number.isFinite(layout.scale)).toBe(true)
    expect(layout.scale).toBeGreaterThan(0)
  })
})
