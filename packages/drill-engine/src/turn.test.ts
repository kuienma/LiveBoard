import { describe, expect, it } from 'vitest'
import { solveTurn } from './turn.js'

/**
 * 角度约定：0° 指向 +x（画面右），顺时针为正（y 轴向下）。
 * 于是 -90° = 朝上（画面北），90° = 朝下（南），180° = 朝左（西），0° = 朝右（东）。
 * direction：+1 顺时针，-1 逆时针。
 */

const NORTH = -90
const SOUTH = 90
const EAST = 0

describe('背向对手转身', () => {
  it('朝北、对手在东侧 → 逆时针（球从左侧绕过）', () => {
    const result = solveTurn(NORTH, 180, [0, 0], [2, 0.3])
    expect(result.direction).toBe(-1)
    expect(result.delta).toBe(-180)
    expect(result.facingTo).toBeCloseTo(SOUTH, 6)
    expect(result.degenerate).toBe(false)
  })

  it('朝北、对手在西侧 → 顺时针（球从右侧绕过）', () => {
    const result = solveTurn(NORTH, 180, [0, 0], [-2, 0.3])
    expect(result.direction).toBe(1)
    expect(result.delta).toBe(180)
    expect(result.facingTo).toBeCloseTo(SOUTH, 6)
  })

  it('朝南、对手在东侧 → 顺时针', () => {
    const result = solveTurn(SOUTH, 180, [0, 0], [1, 0.1])
    expect(result.direction).toBe(1)
    expect(result.facingTo).toBeCloseTo(NORTH, 6)
  })

  it('朝南、对手在西侧 → 逆时针', () => {
    const result = solveTurn(SOUTH, 180, [0, 0], [-1, 0.1])
    expect(result.direction).toBe(-1)
    expect(result.facingTo).toBeCloseTo(NORTH, 6)
  })

  it('非 180° 的转身也按同样规则定方向', () => {
    const result = solveTurn(EAST, 90, [0, 0], [0, 1])
    expect(result.direction).toBe(-1)
    expect(result.delta).toBe(-90)
    expect(result.facingTo).toBeCloseTo(NORTH, 6)
  })

  it('degrees 传负数时按绝对值转，方向仍由对手位置决定', () => {
    const result = solveTurn(NORTH, -180, [0, 0], [2, 0.3])
    expect(result.direction).toBe(-1)
    expect(result.delta).toBe(-180)
  })
})

describe('没有 awayFrom 时按 degrees 的正负', () => {
  it('正数顺时针', () => {
    const result = solveTurn(EAST, 90)
    expect(result.direction).toBe(1)
    expect(result.facingTo).toBeCloseTo(SOUTH, 6)
    expect(result.degenerate).toBe(false)
  })

  it('负数逆时针', () => {
    const result = solveTurn(EAST, -90)
    expect(result.direction).toBe(-1)
    expect(result.facingTo).toBeCloseTo(NORTH, 6)
  })
})

describe('方向无法判断时的兜底', () => {
  it('对手正好在正前方 → 标记 degenerate 并逆时针', () => {
    const result = solveTurn(EAST, 180, [0, 0], [3, 0])
    expect(result.degenerate).toBe(true)
    expect(result.direction).toBe(-1)
  })

  it('对手正好在正后方 → 标记 degenerate', () => {
    const result = solveTurn(EAST, 180, [0, 0], [-3, 0])
    expect(result.degenerate).toBe(true)
    expect(result.direction).toBe(-1)
  })

  it('对手和自己重合 → 标记 degenerate', () => {
    const result = solveTurn(NORTH, 180, [5, 5], [5, 5])
    expect(result.degenerate).toBe(true)
    expect(result.direction).toBe(-1)
  })
})

describe('纯函数', () => {
  it('同样输入永远同样输出，且不修改入参', () => {
    const self: [number, number] = [1, 2]
    const target: [number, number] = [3, 4]
    const a = solveTurn(NORTH, 180, self, target)
    const b = solveTurn(NORTH, 180, self, target)
    expect(a).toEqual(b)
    expect(self).toEqual([1, 2])
    expect(target).toEqual([3, 4])
  })
})
