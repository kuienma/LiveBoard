import type { Vec2 } from '@drill/schema'
import { describe, expect, it } from 'vitest'
import { distance, easeRamp } from './math.js'
import { smoothRoute } from './smooth.js'

/** 折线在 b 处的转角（度）：180 表示笔直，0 表示原地掉头。 */
function cornerAngle(a: Vec2, b: Vec2, c: Vec2): number {
  const inX = b[0] - a[0]
  const inY = b[1] - a[1]
  const outX = c[0] - b[0]
  const outY = c[1] - b[1]
  const cos =
    (inX * outX + inY * outY) / (Math.hypot(inX, inY) * Math.hypot(outX, outY))
  return 180 - (Math.acos(Math.min(Math.max(cos, -1), 1)) * 180) / Math.PI
}

/** 一条折线上最尖的那个转角。 */
function sharpestCorner(points: readonly Vec2[]): number {
  let sharpest = 180
  for (let i = 1; i < points.length - 1; i++) {
    sharpest = Math.min(sharpest, cornerAngle(points[i - 1]!, points[i]!, points[i + 1]!))
  }
  return sharpest
}

describe('smoothRoute', () => {
  it('两个点是直线，原样返回', () => {
    const result = smoothRoute([
      [0, 0],
      [10, 0],
    ])
    expect(result.points).toEqual([
      [0, 0],
      [10, 0],
    ])
    expect(result.waypointIndexes).toEqual([0, 1])
  })

  it('精确穿过每一个路点——跑到锥桶不能抄近道', () => {
    const waypoints: Vec2[] = [
      [0, 0],
      [5, 3],
      [10, 0],
      [15, 4],
    ]
    const { points, waypointIndexes } = smoothRoute(waypoints)
    for (const [index, waypoint] of waypoints.entries()) {
      const onCurve = points[waypointIndexes[index]!]!
      expect(distance(onCurve, waypoint)).toBeLessThan(1e-9)
    }
  })

  it('共线的点平滑后仍然是直线', () => {
    const { points } = smoothRoute([
      [0, 0],
      [5, 0],
      [10, 0],
    ])
    for (const point of points) {
      expect(Math.abs(point[1])).toBeLessThan(1e-9)
    }
  })

  it('把折角磨圆：平滑后最尖的转角比原来钝得多', () => {
    const waypoints: Vec2[] = [
      [0, 0],
      [5, 0],
      [5, 5],
    ]
    // 原折线在 [5,0] 处是 90 度硬角
    expect(sharpestCorner(waypoints)).toBeCloseTo(90, 5)
    // 平滑后每一步的转向都很小，看起来才是曲线
    expect(sharpestCorner(smoothRoute(waypoints).points)).toBeGreaterThan(160)
  })

  it('接近掉头的折返保留尖角，不会凭空画出圆弧', () => {
    const waypoints: Vec2[] = [
      [0, 0],
      [10, 0],
      [0, 0.2],
    ]
    const { points } = smoothRoute(waypoints)
    // 折返点两侧不细分，点数就等于路点数
    expect(points).toHaveLength(3)
  })

  it('不过冲：曲线不会甩到路点包围盒之外太远', () => {
    const waypoints: Vec2[] = [
      [0, 0],
      [1, 0],
      [1, 10],
      [2, 10],
    ]
    const { points } = smoothRoute(waypoints)
    const maxX = Math.max(...waypoints.map((p) => p[0]))
    const minX = Math.min(...waypoints.map((p) => p[0]))
    for (const [x] of points) {
      // 点距悬殊（1 米接 10 米）时均匀 Catmull-Rom 会甩出很远，向心版本不会
      expect(x).toBeLessThan(maxX + 0.6)
      expect(x).toBeGreaterThan(minX - 0.6)
    }
  })

  it('外凸被夹住：点距悬殊时也不会甩出路点范围一米以上', () => {
    // 1 米接 10 米这种悬殊点距是最容易过冲的情形
    const waypoints: Vec2[] = [
      [0, 0],
      [1, 0],
      [1, 10],
      [2, 10],
    ]
    const { points } = smoothRoute(waypoints)
    const bulge = Math.max(
      ...points.map(([x, y]) => {
        const dx = Math.max(0, Math.min(...waypoints.map((p) => p[0])) - x, x - Math.max(...waypoints.map((p) => p[0])))
        const dy = Math.max(0, Math.min(...waypoints.map((p) => p[1])) - y, y - Math.max(...waypoints.map((p) => p[1])))
        return Math.hypot(dx, dy)
      }),
    )
    // 场地只有 20 米宽，外凸一两米就是肉眼可见的「跑出界」
    expect(bulge).toBeLessThan(0.35)
  })

  it('平滑后的路径长度不会离原折线太远', () => {
    const waypoints: Vec2[] = [
      [0, 0],
      [5, 3],
      [10, 0],
    ]
    const length = (points: readonly Vec2[]) =>
      points.slice(1).reduce((sum, point, i) => sum + distance(points[i]!, point), 0)
    const original = length(waypoints)
    const smoothed = length(smoothRoute(waypoints).points)
    // 磨圆会稍微变短或变长，但不该有量级差异
    expect(smoothed).toBeGreaterThan(original * 0.9)
    expect(smoothed).toBeLessThan(original * 1.1)
  })
})

describe('easeRamp：连续跑动不该在阶段边界停下', () => {
  /** 用差分估计速度。 */
  const speedAt = (p: number, rampIn: boolean, rampOut: boolean) => {
    const h = 1e-4
    return (easeRamp(p + h, rampIn, rampOut) - easeRamp(p - h, rampIn, rampOut)) / (2 * h)
  }

  it('两端都归一到 0 和 1，不管哪种组合', () => {
    for (const [rampIn, rampOut] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      expect(easeRamp(0, rampIn, rampOut)).toBeCloseTo(0, 10)
      expect(easeRamp(1, rampIn, rampOut)).toBeCloseTo(1, 10)
    }
  })

  it('只加速：起点速度为 0，终点仍在全速——下一阶段能无缝接上', () => {
    expect(speedAt(0.001, true, false)).toBeLessThan(0.05)
    expect(speedAt(0.999, true, false)).toBeGreaterThan(0.9)
  })

  it('只减速：起点就是全速，终点减到 0', () => {
    expect(speedAt(0.001, false, true)).toBeGreaterThan(0.9)
    expect(speedAt(0.999, false, true)).toBeLessThan(0.05)
  })

  it('中间阶段匀速：全程速度恒定', () => {
    for (const p of [0.01, 0.3, 0.5, 0.8, 0.99]) {
      expect(speedAt(p, false, false)).toBeCloseTo(1, 6)
    }
  })

  it('单独一段（两端都缓动）保持原来的 easeInOut 手感', () => {
    expect(easeRamp(0.5, true, true)).toBeCloseTo(0.5, 10)
    expect(speedAt(0.001, true, true)).toBeLessThan(0.05)
    expect(speedAt(0.999, true, true)).toBeLessThan(0.05)
  })

  it('全程单调不后退', () => {
    for (const [rampIn, rampOut] of [[true, false], [false, true], [true, true]] as const) {
      let previous = -1
      for (let p = 0; p <= 1; p += 0.01) {
        const value = easeRamp(p, rampIn, rampOut)
        expect(value).toBeGreaterThanOrEqual(previous - 1e-12)
        previous = value
      }
    }
  })
})
