import type { Vec2 } from '@drill/schema'

/**
 * 角度约定：度数，0° 指向 +x（画面右），顺时针为正（因为 y 轴向下）。
 * 于是朝向向量 = [cos θ, sin θ]，θ 增大即画面上的顺时针旋转。
 */

export function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]]
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]]
}

export function scale(v: Vec2, k: number): Vec2 {
  return [v[0] * k, v[1] * k]
}

export function length(v: Vec2): number {
  return Math.hypot(v[0], v[1])
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/** 零向量返回 [0, 0]，调用方需自行处理退化情况。 */
export function normalize(v: Vec2): Vec2 {
  const len = length(v)
  return len === 0 ? [0, 0] : [v[0] / len, v[1] / len]
}

export function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p
}

export function lerpVec(a: Vec2, b: Vec2, p: number): Vec2 {
  return [lerp(a[0], b[0], p), lerp(a[1], b[1], p)]
}

export const degToRad = (deg: number): number => (deg * Math.PI) / 180
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI

/** 把角度规范到 (-180, 180]。 */
export function normalizeDeg(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180
  // -180 归到 +180，保证区间是左开右闭，避免 ±180 两种表示
  return wrapped === -180 ? 180 : wrapped
}

/** 向量的朝向角（度）。零向量返回 undefined。 */
export function headingOf(v: Vec2): number | undefined {
  if (v[0] === 0 && v[1] === 0) return undefined
  return radToDeg(Math.atan2(v[1], v[0]))
}

export function facingVector(deg: number): Vec2 {
  const rad = degToRad(deg)
  return [Math.cos(rad), Math.sin(rad)]
}

/** smoothstep：起步和收尾都平缓，符合球员加速减速的直觉。 */
export function easeInOut(p: number): number {
  const c = clamp01(p)
  return c * c * (3 - 2 * c)
}

/**
 * 梯形速度曲线：按需要在开头加速、在结尾减速，中间匀速。
 *
 * 为什么需要它：easeInOut 是「起步加速 + 到点停住」，用在每个阶段上，
 * 一个球员连着跑三个阶段就会在每个阶段边界减速到 0 再重新起步，看着一顿一顿。
 * 连续跑动时只在整段路线的头尾缓动，中间保持匀速，动作才连贯。
 *
 * 面积归一化保证 f(0)=0、f(1)=1：加速段少走的距离由匀速段补回来。
 */
export function easeRamp(p: number, rampIn: boolean, rampOut: boolean, ramp = 0.35): number {
  const c = clamp01(p)
  if (rampIn && rampOut) return easeInOut(c)
  if (!rampIn && !rampOut) return c

  const r = Math.min(Math.max(ramp, 0), 1)
  if (r === 0) return c

  // 只加速：前 r 段是抛物线，其后匀速
  const accelerate = (x: number): number => {
    const scale = 1 - r / 2
    return x <= r ? x * x / (2 * r) / scale : (r / 2 + (x - r)) / scale
  }

  return rampIn ? accelerate(c) : 1 - accelerate(1 - c)
}

export function clamp01(p: number): number {
  if (p < 0) return 0
  if (p > 1) return 1
  return p
}

/** 折线总长度。 */
export function polylineLength(points: readonly Vec2[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1]!, points[i]!)
  }
  return total
}

/** 按弧长比例取折线上的点，p ∈ [0, 1]。 */
export function polylinePoint(points: readonly Vec2[], p: number): Vec2 {
  const first = points[0]
  if (first === undefined) {
    throw new Error('折线至少需要一个点')
  }
  const last = points[points.length - 1]!
  if (points.length === 1) return first
  if (p <= 0) return first
  if (p >= 1) return last

  const total = polylineLength(points)
  if (total === 0) return first

  let remaining = p * total
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const segLength = distance(a, b)
    if (remaining <= segLength) {
      return lerpVec(a, b, segLength === 0 ? 0 : remaining / segLength)
    }
    remaining -= segLength
  }
  return last
}

/** 折线在比例 p 处的前进方向（度）。整条折线长度为 0 时返回 undefined。 */
export function polylineHeading(points: readonly Vec2[], p: number): number | undefined {
  if (points.length < 2) return undefined
  const total = polylineLength(points)
  if (total === 0) return undefined

  let remaining = clamp01(p) * total
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const segLength = distance(a, b)
    if (segLength === 0) continue
    if (remaining <= segLength || i === points.length - 1) {
      return headingOf(sub(b, a))
    }
    remaining -= segLength
  }
  return undefined
}

/** 截取折线的前 p 段，用于画「已经跑过的路线」。 */
export function polylineUpTo(points: readonly Vec2[], p: number): Vec2[] {
  const first = points[0]
  if (first === undefined) return []
  if (points.length === 1) return [first]

  const clamped = clamp01(p)
  if (clamped <= 0) return [first]
  if (clamped >= 1) return [...points]

  const total = polylineLength(points)
  if (total === 0) return [first]

  const out: Vec2[] = [first]
  let remaining = clamped * total
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const segLength = distance(a, b)
    if (remaining >= segLength) {
      out.push(b)
      remaining -= segLength
      continue
    }
    out.push(lerpVec(a, b, segLength === 0 ? 0 : remaining / segLength))
    break
  }
  return out
}
