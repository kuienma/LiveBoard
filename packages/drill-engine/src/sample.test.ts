import { parseDrill, type Drill } from '@drill/schema'
import { beforeAll, describe, expect, it } from 'vitest'
import raw from '../../../fixtures/side-attack.json'
import { BALL_DISTANCE, compileVariant, type Timeline } from './compile.js'
import { sampleTimeline, type FrameState } from './sample.js'

let drill: Drill
let basic: Timeline
let var1: Timeline
let var2: Timeline

beforeAll(() => {
  const result = parseDrill(raw)
  if (!result.ok) throw new Error('示例数据未通过校验')
  drill = result.drill
  basic = compileVariant(drill, 'basic')
  var1 = compileVariant(drill, 'var1')
  var2 = compileVariant(drill, 'var2')
})

function actor(frame: FrameState, id: string) {
  const found = frame.actors.find((a) => a.id === id)
  if (found === undefined) throw new Error(`帧里没有球员 ${id}`)
  return found
}

function ball(frame: FrameState) {
  const found = frame.balls[0]
  if (found === undefined) throw new Error('帧里没有球')
  return found
}

/** 每轮 5.7 秒：2.4 带球上前 + 0.9 转身 + 2.4 带球回来。 */
const ROUND = 5.7
const TURN_START = 2.4
const TURN_MID = TURN_START + 0.45

describe('关键时刻的位置', () => {
  it('t=0 站在初始位置，球在 A 脚前（朝北，所以球在正上方）', () => {
    const frame = sampleTimeline(basic, 0)
    expect(actor(frame, 'A').pos).toEqual([10, 12.4])
    expect(actor(frame, 'B').pos).toEqual([16, 3.8])
    expect(actor(frame, 'coach').pos).toEqual([15, 12])
    expect(actor(frame, 'A').facing).toBeCloseTo(-90, 6)

    const [bx, by] = ball(frame).pos
    expect(bx).toBeCloseTo(10, 6)
    expect(by).toBeCloseTo(12.4 - BALL_DISTANCE, 6)
    expect(ball(frame).ownerId).toBe('A')
  })

  it('第一段结束时 A 到中间锥桶下方、B 到右侧', () => {
    const frame = sampleTimeline(basic, TURN_START)
    expect(actor(frame, 'A').pos[0]).toBeCloseTo(10, 6)
    expect(actor(frame, 'A').pos[1]).toBeCloseTo(4.2, 6)
    expect(actor(frame, 'B').pos[0]).toBeCloseTo(12, 6)
    expect(actor(frame, 'B').pos[1]).toBeCloseTo(4.5, 6)
  })

  it('一轮结束回到起点', () => {
    const frame = sampleTimeline(basic, ROUND)
    expect(actor(frame, 'A').pos[0]).toBeCloseTo(10, 6)
    expect(actor(frame, 'A').pos[1]).toBeCloseTo(12.4, 6)
  })

  it('中途位置落在起点和终点之间', () => {
    const frame = sampleTimeline(basic, 1.2)
    const y = actor(frame, 'A').pos[1]
    expect(y).toBeLessThan(12.4)
    expect(y).toBeGreaterThan(4.2)
  })
})

describe('转身时球从哪一侧绕过', () => {
  it('基本练法：B 在右，球从 A 的左侧绕过', () => {
    const frame = sampleTimeline(basic, TURN_MID)
    const a = actor(frame, 'A')
    const b = actor(frame, 'B')
    expect(b.pos[0]).toBeGreaterThan(a.pos[0]) // B 确实在右边

    // 转身进行到一半，球正好在 A 的正左方
    expect(ball(frame).pos[0]).toBeLessThan(a.pos[0])
    expect(ball(frame).pos[0]).toBeCloseTo(10 - BALL_DISTANCE, 6)
    expect(ball(frame).pos[1]).toBeCloseTo(4.2, 6)
  })

  it('变化一：B 在左，球从 A 的右侧绕过', () => {
    const frame = sampleTimeline(var1, TURN_MID)
    const a = actor(frame, 'A')
    expect(actor(frame, 'B').pos[0]).toBeLessThan(a.pos[0])
    expect(ball(frame).pos[0]).toBeGreaterThan(a.pos[0])
    expect(ball(frame).pos[0]).toBeCloseTo(10 + BALL_DISTANCE, 6)
  })

  it('变化二：第 1 轮球走左侧，第 2 轮球走右侧', () => {
    const round1 = sampleTimeline(var2, TURN_MID)
    expect(round1.roundIndex).toBe(0)
    expect(ball(round1).pos[0]).toBeLessThan(actor(round1, 'A').pos[0])

    const round2 = sampleTimeline(var2, ROUND + TURN_MID)
    expect(round2.roundIndex).toBe(1)
    expect(ball(round2).pos[0]).toBeGreaterThan(actor(round2, 'A').pos[0])
  })

  it('球绕行半径大于球员圆点半径，绕行方向才看得清', () => {
    expect(BALL_DISTANCE).toBeGreaterThan(0.5)
  })

  it('球在转身全程都贴着 A，不会飞走', () => {
    for (let t = TURN_START; t <= TURN_START + 0.9; t += 0.05) {
      const frame = sampleTimeline(basic, t)
      const a = actor(frame, 'A')
      const distance = Math.hypot(ball(frame).pos[0] - a.pos[0], ball(frame).pos[1] - a.pos[1])
      expect(distance).toBeCloseTo(BALL_DISTANCE, 6)
    }
  })
})

describe('慢放与转身高亮', () => {
  it('慢放阶段给出转身高亮', () => {
    const frame = sampleTimeline(basic, TURN_MID)
    expect(frame.slowMotion).toBe(true)
    expect(frame.turnHighlight?.actorId).toBe('A')
    expect(frame.turnHighlight?.direction).toBe(-1)
    expect(frame.turnHighlight?.fromFacing).toBeCloseTo(-90, 6)
  })

  it('非慢放阶段没有高亮', () => {
    const frame = sampleTimeline(basic, 1.0)
    expect(frame.slowMotion).toBe(false)
    expect(frame.turnHighlight).toBeUndefined()
  })

  it('slowMotion 不改变时长：三个阶段加起来就是一轮 5.7 秒', () => {
    expect(basic.duration).toBeCloseTo(ROUND * 3, 6)
  })
})

describe('轮次与顶部文字', () => {
  it('轮次索引随时间推进', () => {
    expect(sampleTimeline(var2, 0).roundIndex).toBe(0)
    expect(sampleTimeline(var2, ROUND + 0.1).roundIndex).toBe(1)
    expect(sampleTimeline(var2, ROUND * 2 + 0.1).roundIndex).toBe(2)
    expect(sampleTimeline(var2, ROUND * 3 + 0.1).roundIndex).toBe(3)
    expect(sampleTimeline(var2, 0).roundTotal).toBe(4)
  })

  it('顶部文字随轮次交替', () => {
    expect(sampleTimeline(var2, 1).narration).toContain('防守者从右边来')
    expect(sampleTimeline(var2, ROUND + 1).narration).toContain('防守者从左边来')
    expect(sampleTimeline(var2, ROUND * 2 + 1).narration).toContain('防守者从右边来')
  })

  it('阶段索引正确', () => {
    expect(sampleTimeline(basic, 1).phaseIndex).toBe(0)
    expect(sampleTimeline(basic, TURN_MID).phaseIndex).toBe(1)
    expect(sampleTimeline(basic, 4).phaseIndex).toBe(2)
  })
})

describe('跑动虚线', () => {
  it('只画当前轮次的路线，换轮清空', () => {
    const lateRound1 = sampleTimeline(basic, ROUND - 0.1)
    const trailA1 = lateRound1.trails.find((t) => t.actorId === 'A')!
    // 第一轮快结束时，A 已经上去又回来，路线较长
    expect(trailA1.points.length).toBeGreaterThanOrEqual(3)

    const earlyRound2 = sampleTimeline(basic, ROUND + 0.1)
    const trailA2 = earlyRound2.trails.find((t) => t.actorId === 'A')!
    expect(trailA2.points[0]).toEqual([10, 12.4]) // 从本轮起点重新开始
    expect(trailA2.points.length).toBeLessThan(trailA1.points.length)
  })

  it('路线随时间变长', () => {
    const short = sampleTimeline(basic, 0.5).trails.find((t) => t.actorId === 'A')!
    const long = sampleTimeline(basic, 2.0).trails.find((t) => t.actorId === 'A')!
    const lengthOf = (points: [number, number][]) =>
      points.reduce(
        (sum, p, i) => (i === 0 ? 0 : sum + Math.hypot(p[0] - points[i - 1]![0], p[1] - points[i - 1]![1])),
        0,
      )
    expect(lengthOf(long.points)).toBeGreaterThan(lengthOf(short.points))
  })
})

describe('边界与健壮性', () => {
  it('t 超出范围会被夹住', () => {
    const before = sampleTimeline(basic, -5)
    const after = sampleTimeline(basic, 999)
    expect(before.time).toBe(0)
    expect(after.time).toBeCloseTo(basic.duration, 6)
    expect(actor(before, 'A').pos).toEqual([10, 12.4])
  })

  it('按 30fps 扫全程都不抛错，且所有人都在场内', () => {
    for (const timeline of [basic, var1, var2]) {
      const frames = Math.ceil(timeline.duration * 30)
      for (let i = 0; i <= frames; i++) {
        const frame = sampleTimeline(timeline, i / 30)
        for (const a of frame.actors) {
          expect(Number.isFinite(a.pos[0])).toBe(true)
          expect(Number.isFinite(a.pos[1])).toBe(true)
          expect(a.pos[0]).toBeGreaterThanOrEqual(0)
          expect(a.pos[0]).toBeLessThanOrEqual(timeline.field.width)
          expect(a.pos[1]).toBeGreaterThanOrEqual(0)
          expect(a.pos[1]).toBeLessThanOrEqual(timeline.field.height)
          expect(Number.isFinite(a.facing)).toBe(true)
        }
      }
    }
  })
})

describe('纯函数', () => {
  it('同一个 t 采样两次结果完全相同（导出逐帧截图依赖这一点）', () => {
    expect(sampleTimeline(var2, 7.35)).toEqual(sampleTimeline(var2, 7.35))
  })

  it('乱序采样不影响结果，可以随意拖动进度条', () => {
    const ordered = [1, 2, 3, 4, 5].map((t) => sampleTimeline(var2, t))
    const shuffled = [5, 3, 1, 4, 2].map((t) => sampleTimeline(var2, t))
    expect(shuffled[2]).toEqual(ordered[0])
    expect(shuffled[0]).toEqual(ordered[4])
  })

  it('采样不修改时间线', () => {
    const snapshot = structuredClone(var2)
    sampleTimeline(var2, 3.3)
    expect(var2).toEqual(snapshot)
  })
})
