import type { Vec2 } from '@drill/schema'
import { describe, expect, it } from 'vitest'
import { polylineLength, waveAlongPolyline } from './wave.js'

const straight = (length: number): Vec2[] => [
  [0, 0],
  [length, 0],
]

const OPTIONS = { wavelength: 1.1, amplitude: 0.26 }

describe('waveAlongPolyline', () => {
  it('首尾点精确保留——端点接着球员圆点，差一点就看得出来', () => {
    const points: Vec2[] = [
      [1, 2],
      [9, 6],
    ]
    const wave = waveAlongPolyline(points, OPTIONS)
    expect(wave[0]).toEqual([1, 2])
    expect(wave.at(-1)).toEqual([9, 6])
  })

  it('真的摆动起来了：有点偏到路径两侧', () => {
    const wave = waveAlongPolyline(straight(10), OPTIONS)
    const offsets = wave.map(([, y]) => y)
    expect(Math.max(...offsets)).toBeGreaterThan(0.1)
    expect(Math.min(...offsets)).toBeLessThan(-0.1)
  })

  it('振幅不超过设定值，不会甩出场地', () => {
    const wave = waveAlongPolyline(straight(12), OPTIONS)
    for (const [, y] of wave) {
      expect(Math.abs(y)).toBeLessThanOrEqual(OPTIONS.amplitude + 1e-9)
    }
  })

  it('两端振幅渐入渐出，不会从球员身侧莫名冒出来', () => {
    const wave = waveAlongPolyline(straight(10), OPTIONS)
    // 前两个点仍贴近路径
    expect(Math.abs(wave[1]![1])).toBeLessThan(OPTIONS.amplitude * 0.6)
    expect(Math.abs(wave.at(-2)![1])).toBeLessThan(OPTIONS.amplitude * 0.6)
  })

  it('路径不足一个波长时原样返回——半个波浪只会让人以为画错了', () => {
    const short = straight(0.8)
    expect(waveAlongPolyline(short, OPTIONS)).toEqual(short)
  })

  it('少于两个点、或振幅波长非法时原样返回', () => {
    expect(waveAlongPolyline([[1, 1]], OPTIONS)).toEqual([[1, 1]])
    expect(waveAlongPolyline(straight(10), { wavelength: 0, amplitude: 0.2 })).toEqual(straight(10))
    expect(waveAlongPolyline(straight(10), { wavelength: 1, amplitude: 0 })).toEqual(straight(10))
  })

  it('波浪线比原路径长，但长不过一倍', () => {
    const base = straight(10)
    const wave = waveAlongPolyline(base, OPTIONS)
    const ratio = polylineLength(wave) / polylineLength(base)
    expect(ratio).toBeGreaterThan(1)
    expect(ratio).toBeLessThan(2)
  })

  it('整条线容纳整数个波长，收尾不停在半个波峰上', () => {
    // 10 米、波长 1.1 → 取 9 个波长，实际波长 10/9
    const wave = waveAlongPolyline(straight(10), OPTIONS)
    // 末端回到路径上（振幅渐出 + 整数波长共同保证）
    expect(Math.abs(wave.at(-1)![1])).toBeLessThan(1e-9)
  })

  it('沿曲线走时也贴着曲线摆动，不会偏离原路径太远', () => {
    // 一条明显拐弯的折线
    const bent: Vec2[] = [
      [0, 0],
      [5, 0],
      [5, 5],
    ]
    const wave = waveAlongPolyline(bent, OPTIONS)
    // 每个波浪点到原折线的距离不该超过振幅（多一点容差给拐角处）
    for (const point of wave) {
      expect(distanceToPolyline(point, bent)).toBeLessThan(OPTIONS.amplitude + 0.05)
    }
  })
})

/** 点到折线的最短距离。 */
function distanceToPolyline(point: Vec2, polyline: readonly Vec2[]): number {
  let best = Infinity
  for (let i = 1; i < polyline.length; i++) {
    best = Math.min(best, distanceToSegment(point, polyline[i - 1]!, polyline[i]!))
  }
  return best
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
