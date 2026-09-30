import type { Vec2 } from '@drill/schema'

/**
 * 把折线变成沿它左右摆动的波浪线。
 *
 * 战术图的约定：带球画波浪线，无球跑动画直线/虚线。两者线形必须能一眼区分，
 * 否则「谁带着球跑」这个最关键的信息在图上就丢了。
 *
 * 做成纯函数是为了能单测：波浪的正确性（首尾对齐、振幅受控、不跑偏）
 * 在画布上肉眼校验代价高，而算错了整条线会歪到场地外。
 */

export interface WaveOptions {
  /** 一个完整波长的长度（米）。 */
  wavelength: number
  /** 摆动幅度（米，单侧）。 */
  amplitude: number
  /** 每个波长切成几段直线来近似。越大越圆滑。 */
  stepsPerWave?: number
}

/**
 * 沿折线生成波浪点列。
 *
 * 两端振幅收敛到 0：波浪如果在起点就偏出去，线看起来会从球员身侧莫名冒出来。
 * 路径太短（不足一个波长）时原样返回——半个波浪只会让人以为画错了。
 */
export function waveAlongPolyline(points: readonly Vec2[], options: WaveOptions): Vec2[] {
  if (points.length < 2) return [...points]

  const { wavelength, amplitude } = options
  const steps = options.stepsPerWave ?? 8
  const total = polylineLength(points)
  if (total < wavelength || wavelength <= 0 || amplitude <= 0) return [...points]

  // 让整条线正好容纳整数个波长，收尾才不会停在半个波峰上
  const waves = Math.max(1, Math.round(total / wavelength))
  const actualWavelength = total / waves
  const stepLength = actualWavelength / steps

  const out: Vec2[] = []
  for (let distance = 0; distance <= total + 1e-9; distance += stepLength) {
    const at = Math.min(distance, total)
    const [point, tangent] = pointAndTangent(points, at)

    // 两端各用半个波长把振幅渐入渐出
    const fade = Math.min(1, at / (actualWavelength / 2), (total - at) / (actualWavelength / 2))
    const offset = Math.sin((at / actualWavelength) * Math.PI * 2) * amplitude * Math.max(0, fade)

    // 法线 = 切线转 90°
    out.push([point[0] - tangent[1] * offset, point[1] + tangent[0] * offset])
  }

  // 精确对齐首尾：浮点累加可能差一点，而端点接着球员圆点，差一点就看得出来
  out[0] = [...points[0]!] as Vec2
  out[out.length - 1] = [...points[points.length - 1]!] as Vec2
  return out
}

export function polylineLength(points: readonly Vec2[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1])
  }
  return total
}

/** 折线在弧长 at 处的点和单位切线。 */
function pointAndTangent(points: readonly Vec2[], at: number): [Vec2, Vec2] {
  let remaining = at
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (length === 0) continue

    if (remaining <= length) {
      const t = remaining / length
      return [
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        [(b[0] - a[0]) / length, (b[1] - a[1]) / length],
      ]
    }
    remaining -= length
  }

  // 落在末尾：用最后一段的方向
  const last = points[points.length - 1]!
  const prev = points[points.length - 2] ?? last
  const length = Math.hypot(last[0] - prev[0], last[1] - prev[1]) || 1
  return [[...last] as Vec2, [(last[0] - prev[0]) / length, (last[1] - prev[1]) / length]]
}
