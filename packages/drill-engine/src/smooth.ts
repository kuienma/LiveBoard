import type { Vec2 } from '@drill/schema'
import { distance } from './math.js'

/**
 * 把折线路点变成平滑曲线。
 *
 * 用向心 Catmull-Rom（alpha = 0.5）而不是「切角」（圆角过渡）：
 * 曲线**精确穿过每一个路点**。训练里的路点往往就是锥桶——
 * 「跑到锥桶再折返」如果被切角抄了近道，就把练法讲错了。
 * 代价是拐弯处会略微外凸，这反而更像真人跑动。
 *
 * 向心参数化（而不是均匀参数化）的原因：均匀 Catmull-Rom 在相邻点间距
 * 相差很大时会打圈、自交；向心版本数学上保证不出现尖点和自交。
 */

/** 每两个路点之间细分成多少段。12 段在 1080p 下已经看不出直线痕迹。 */
const SUBDIVISIONS = 12

/**
 * 夹角小于这个值（度）就当成折返，不做平滑。
 *
 * 原地掉头（比如转身后往回跑）本来就该是尖角，硬平滑会画出一个凭空的圆弧。
 */
const REVERSAL_ANGLE_DEG = 30

export interface SmoothResult {
  /** 细分后的密集折线。 */
  points: Vec2[]
  /** 每个原始路点在 points 里的下标，用来按阶段切回去。 */
  waypointIndexes: number[]
}

/**
 * 平滑一条路线。
 *
 * 两个点（直线）原样返回；共线的点也几乎保持直线，
 * 所以只走直线的练法看起来不会有任何变化。
 */
export function smoothRoute(waypoints: readonly Vec2[], subdivisions = SUBDIVISIONS): SmoothResult {
  if (waypoints.length < 3) {
    return { points: [...waypoints], waypointIndexes: waypoints.map((_, index) => index) }
  }

  const points: Vec2[] = [waypoints[0]!]
  const waypointIndexes: number[] = [0]

  for (let i = 0; i < waypoints.length - 1; i++) {
    const p1 = waypoints[i]!
    const p2 = waypoints[i + 1]!

    // 端点处没有「前一个 / 后一个」，镜像出一个虚拟点，曲线在端点才不会歪
    const p0 = waypoints[i - 1] ?? mirror(p1, p2)
    const p3 = waypoints[i + 2] ?? mirror(p2, p1)

    // 折返角不平滑：直接连直线，让尖角留在那儿
    const sharp = isReversal(p0, p1, p2) || isReversal(p1, p2, p3)
    if (sharp || distance(p1, p2) === 0) {
      points.push(p2)
      waypointIndexes.push(points.length - 1)
      continue
    }

    for (let step = 1; step <= subdivisions; step++) {
      points.push(catmullRom(p0, p1, p2, p3, step / subdivisions))
    }
    waypointIndexes.push(points.length - 1)
  }

  return { points, waypointIndexes }
}

/** 以 from 为中心把 other 镜像到另一侧，用作端点的虚拟控制点。 */
function mirror(from: Vec2, other: Vec2): Vec2 {
  return [from[0] * 2 - other[0], from[1] * 2 - other[1]]
}

/** b 处的转角是否接近掉头。 */
function isReversal(a: Vec2, b: Vec2, c: Vec2): boolean {
  const inX = b[0] - a[0]
  const inY = b[1] - a[1]
  const outX = c[0] - b[0]
  const outY = c[1] - b[1]
  const inLen = Math.hypot(inX, inY)
  const outLen = Math.hypot(outX, outY)
  if (inLen === 0 || outLen === 0) return false

  // 两个方向的夹角：cos 接近 -1 说明几乎原路返回
  const cos = (inX * outX + inY * outY) / (inLen * outLen)
  const angle = (Math.acos(Math.min(Math.max(cos, -1), 1)) * 180) / Math.PI
  return angle > 180 - REVERSAL_ANGLE_DEG
}

/**
 * 向心 Catmull-Rom 在 p1→p2 段上取点，t ∈ [0, 1]。
 *
 * 按 Barry–Goldman 的写法展开成三次 Hermite：
 * 用相邻点距离的 0.5 次幂做参数间距，得到的切线不会因为点距悬殊而过冲。
 */
function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const d01 = Math.max(Math.sqrt(distance(p0, p1)), 1e-6)
  const d12 = Math.max(Math.sqrt(distance(p1, p2)), 1e-6)
  const d23 = Math.max(Math.sqrt(distance(p2, p3)), 1e-6)

  // 切线按向心参数化算，再按弦长夹一下长度
  const m1: Vec2 = [tangentAt(0, p0, p1, p2, d01, d12), tangentAt(1, p0, p1, p2, d01, d12)]
  const m2: Vec2 = [tangentAt(0, p1, p2, p3, d12, d23), tangentAt(1, p1, p2, p3, d12, d23)]

  const chord = distance(p1, p2)
  clampLength(m1, chord * MAX_TANGENT_RATIO)
  clampLength(m2, chord * MAX_TANGENT_RATIO)

  const t2 = t * t
  const t3 = t2 * t
  const h1 = 2 * t3 - 3 * t2 + 1
  const h2 = t3 - 2 * t2 + t
  const h3 = -2 * t3 + 3 * t2
  const h4 = t3 - t2

  return [
    h1 * p1[0] + h2 * m1[0] + h3 * p2[0] + h4 * m2[0],
    h1 * p1[1] + h2 * m1[1] + h3 * p2[1] + h4 * m2[1],
  ]
}

/**
 * 某个端点处的切线分量（向心 Catmull-Rom）。
 * prev/mid/next 是该端点前后的三个点，dPrev/dNext 是对应的参数间距。
 */
function tangentAt(
  axis: 0 | 1,
  prev: Vec2,
  mid: Vec2,
  next: Vec2,
  dPrev: number,
  dNext: number,
): number {
  return (
    ((next[axis] - mid[axis]) / dNext -
      (next[axis] - prev[axis]) / (dPrev + dNext) +
      (mid[axis] - prev[axis]) / dPrev) *
    dNext
  )
}

/**
 * 切线长度上限（相对本段弦长）。
 *
 * 不夹的话，一段 1 米接一段 10 米这种悬殊点距会把曲线甩出所有路点之外
 * 一两米——在 20 米的场地上那是明显的「跑出界」。1.0 倍弦长的上限
 * 把外凸压到弦长的十分之一量级，看着还是圆润的弧。
 */
const MAX_TANGENT_RATIO = 1

function clampLength(vector: Vec2, max: number): void {
  const length = Math.hypot(vector[0], vector[1])
  if (length <= max || length === 0) return
  const factor = max / length
  vector[0] *= factor
  vector[1] *= factor
}
