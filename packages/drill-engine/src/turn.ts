import type { Vec2 } from '@drill/schema'
import { headingOf, normalizeDeg, sub } from './math.js'

/** 顺时针为 +1，逆时针为 -1（y 轴向下的屏幕坐标系）。 */
export type TurnDirection = 1 | -1

export interface TurnSolution {
  direction: TurnDirection
  /** 实际转过的角度（带符号，度）。 */
  delta: number
  /** 转身结束时的朝向（度）。 */
  facingTo: number
  /** true 表示对手正好在正前方或正后方，方向无法判断，用了兜底规则。 */
  degenerate: boolean
}

/** 对手在正前方/正后方时的兜底方向：逆时针（画面上朝左）。 */
const FALLBACK_DIRECTION: TurnDirection = -1

/** 判定「对手在当前朝向的哪一侧」的角度容差（度）。 */
const DEGENERATE_EPSILON = 1e-6

/**
 * 解一次转身：转过 |degrees|，方向为「背向 awayFrom 那个对象」。
 *
 * 做法是看对手相对当前朝向的夹角：对手在顺时针一侧就逆时针转，反之顺时针转，
 * 这样球（画在球员朝向前方）扫过的半圆一定在远离对手的那一侧。
 *
 * @param facingFrom 转身前的朝向（度）
 * @param degrees    要转过的角度，取绝对值；没有 awayFrom 时用它的正负决定方向（正 = 顺时针）
 * @param self       转身球员的位置
 * @param awayFrom   对手/对象的位置；缺省则只按 degrees 的正负
 */
export function solveTurn(
  facingFrom: number,
  degrees: number,
  self?: Vec2,
  awayFrom?: Vec2,
): TurnSolution {
  const magnitude = Math.abs(degrees)

  if (self === undefined || awayFrom === undefined) {
    const direction: TurnDirection = degrees < 0 ? -1 : 1
    const delta = magnitude * direction
    return {
      direction,
      delta,
      facingTo: normalizeDeg(facingFrom + delta),
      degenerate: false,
    }
  }

  const toTarget = headingOf(sub(awayFrom, self))
  if (toTarget === undefined) {
    // 对手和自己重合，无法判断方向
    const delta = magnitude * FALLBACK_DIRECTION
    return {
      direction: FALLBACK_DIRECTION,
      delta,
      facingTo: normalizeDeg(facingFrom + delta),
      degenerate: true,
    }
  }

  // relative > 0：对手在当前朝向的顺时针一侧；< 0：逆时针一侧
  const relative = normalizeDeg(toTarget - facingFrom)
  const degenerate = Math.abs(relative) < DEGENERATE_EPSILON || Math.abs(Math.abs(relative) - 180) < DEGENERATE_EPSILON

  const direction: TurnDirection = degenerate
    ? FALLBACK_DIRECTION
    : relative > 0
      ? -1
      : 1

  const delta = magnitude * direction
  return {
    direction,
    delta,
    facingTo: normalizeDeg(facingFrom + delta),
    degenerate,
  }
}
