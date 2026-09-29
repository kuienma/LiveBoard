import { parseDrill, type Drill } from '@drill/schema'
import { beforeAll, describe, expect, it } from 'vitest'
import raw from '../../../fixtures/side-attack.json'
import squareRaw from '../../../fixtures/passing-square.json'
import { compileVariant, type Segment } from './compile.js'
import { sub } from './math.js'
import { sampleTimeline } from './sample.js'

let drill: Drill

beforeAll(() => {
  const result = parseDrill(raw)
  if (!result.ok) throw new Error('示例数据未通过校验')
  drill = result.drill
})

/** 取某一轮某一阶段的 segment。 */
function segmentAt(segments: Segment[], round: number, phase: number): Segment {
  const found = segments.find((s) => s.roundIndex === round && s.phaseIndex === phase)
  if (found === undefined) throw new Error(`找不到第 ${round} 轮第 ${phase} 阶段`)
  return found
}

/** 某个球员在该 segment 结束时的位置。 */
function endPos(segment: Segment, actorId: string): [number, number] {
  const motion = segment.actors.find((m) => m.actorId === actorId)
  if (motion === undefined) throw new Error(`该阶段没有球员 ${actorId}`)
  return motion.points[motion.points.length - 1]!
}

describe('时间线结构', () => {
  it('基本练法展开成 3 轮 × 3 阶段，总时长 17.1 秒', () => {
    const timeline = compileVariant(drill, 'basic')
    expect(timeline.segments).toHaveLength(9)
    expect(timeline.duration).toBeCloseTo(17.1, 6)
    expect(timeline.rounds).toHaveLength(3)
    expect(timeline.rounds[1]!.startTime).toBeCloseTo(5.7, 6)
  })

  it('变化二是 4 轮，总时长 22.8 秒', () => {
    const timeline = compileVariant(drill, 'var2')
    expect(timeline.segments).toHaveLength(12)
    expect(timeline.duration).toBeCloseTo(22.8, 6)
  })

  it('段与段首尾相接，没有空隙', () => {
    const timeline = compileVariant(drill, 'var2')
    let expected = 0
    for (const segment of timeline.segments) {
      expect(segment.startTime).toBeCloseTo(expected, 6)
      expected += segment.duration
      expect(segment.endTime).toBeCloseTo(expected, 6)
    }
  })

  it('找不到的练法直接抛错', () => {
    expect(() => compileVariant(drill, 'nope')).toThrow('找不到练法')
  })
})

describe('初始状态', () => {
  it('setup 的相对位置被解析成绝对坐标', () => {
    const timeline = compileVariant(drill, 'basic')
    // start 锥桶在 [10, 13]，A 站它上方 0.6 米
    expect(timeline.initialPositions['A']).toEqual([10, 12.4])
    // right 锥桶在 [16, 3]，B 站它下方 0.8 米
    expect(timeline.initialPositions['B']).toEqual([16, 3.8])
    // 教练用 actors[].pos 的固定站位
    expect(timeline.initialPositions['coach']).toEqual([15, 12])
  })

  it('初始朝向取第一次移动的方向', () => {
    const timeline = compileVariant(drill, 'basic')
    // A 第一步是从 [10, 12.4] 往上带球到 [10, 4.2]，即朝北 -90°
    expect(timeline.initialFacing['A']).toBeCloseTo(-90, 6)
  })

  it('全程不动又没写 facing 的球员默认朝下', () => {
    const timeline = compileVariant(drill, 'basic')
    expect(timeline.initialFacing['coach']).toBe(90)
  })
})

describe('基本练法：B 从右边来，A 向左转身', () => {
  it('每一轮转身都是逆时针（画面上向左）', () => {
    const timeline = compileVariant(drill, 'basic')
    for (let round = 0; round < 3; round++) {
      const turnSegment = segmentAt(timeline.segments, round, 1)
      const motion = turnSegment.actors.find((m) => m.actorId === 'A')!
      expect(motion.turn?.direction, `第 ${round + 1} 轮`).toBe(-1)
      expect(motion.turn?.degenerate).toBe(false)
      expect(motion.facingDelta).toBe(-180)
    }
  })

  it('转身前朝北、转身后朝南，且下一段带球方向与之衔接', () => {
    const timeline = compileVariant(drill, 'basic')
    const turnSegment = segmentAt(timeline.segments, 0, 1)
    const turnMotion = turnSegment.actors.find((m) => m.actorId === 'A')!
    expect(turnMotion.facingFrom).toBeCloseTo(-90, 6)

    // 转身结束朝南（90°），第三段正是往南带球回起点，所以不需要再扭一次
    const backSegment = segmentAt(timeline.segments, 0, 2)
    const backMotion = backSegment.actors.find((m) => m.actorId === 'A')!
    expect(backMotion.facingFrom).toBeCloseTo(90, 6)
    expect(backMotion.facingDelta).toBeCloseTo(0, 6)
  })

  it('顶部文字说明方向', () => {
    const timeline = compileVariant(drill, 'basic')
    expect(timeline.rounds[0]!.narration).toBe('第 1 次：防守者从右边来，运球员向左转身')
    expect(timeline.rounds[1]!.opponentSide).toBe('right')
    expect(timeline.rounds[1]!.turnSide).toBe('left')
  })

  it('每轮结束都回到初始站位，所以三轮完全一样', () => {
    const timeline = compileVariant(drill, 'basic')
    for (let round = 0; round < 3; round++) {
      const last = segmentAt(timeline.segments, round, 2)
      expect(endPos(last, 'A')).toEqual([10, 12.4])
      expect(endPos(last, 'B')).toEqual([16, 3.8])
    }
  })
})

describe('变化一：B 从左边来，A 向右转身', () => {
  it('每一轮转身都是顺时针（画面上向右）', () => {
    const timeline = compileVariant(drill, 'var1')
    for (let round = 0; round < 3; round++) {
      const motion = segmentAt(timeline.segments, round, 1).actors.find((m) => m.actorId === 'A')!
      expect(motion.turn?.direction, `第 ${round + 1} 轮`).toBe(1)
      expect(motion.facingDelta).toBe(180)
    }
  })

  it('顶部文字说明方向', () => {
    const timeline = compileVariant(drill, 'var1')
    expect(timeline.rounds[0]!.narration).toBe('第 1 次：防守者从左边来，运球员向右转身')
    expect(timeline.rounds[0]!.opponentSide).toBe('left')
    expect(timeline.rounds[0]!.turnSide).toBe('right')
  })
})

describe('变化二：swap 让来向与转身方向逐轮交替', () => {
  it('转身方向交替：左、右、左、右', () => {
    const timeline = compileVariant(drill, 'var2')
    const directions = [0, 1, 2, 3].map(
      (round) =>
        segmentAt(timeline.segments, round, 1).actors.find((m) => m.actorId === 'A')!.turn!
          .direction,
    )
    expect(directions).toEqual([-1, 1, -1, 1])
  })

  it('顶部文字逐轮交替', () => {
    const timeline = compileVariant(drill, 'var2')
    expect(timeline.rounds.map((r) => r.narration)).toEqual([
      '第 1 次：防守者从右边来，运球员向左转身',
      '第 2 次：防守者从左边来，运球员向右转身',
      '第 3 次：防守者从右边来，运球员向左转身',
      '第 4 次：防守者从左边来，运球员向右转身',
    ])
  })

  it('swap 互换 left / right 的引用：B 每轮跑向对面的锥桶', () => {
    const timeline = compileVariant(drill, 'var2')
    // 第 1 轮 to 写的是 left，落在左锥桶 [4, 3]+[0,0.8]
    expect(endPos(segmentAt(timeline.segments, 0, 2), 'B')).toEqual([4, 3.8])
    // 第 2 轮 swap 生效，同一句 to: left 解析到右锥桶
    expect(endPos(segmentAt(timeline.segments, 1, 2), 'B')).toEqual([16, 3.8])
    // 第 3 轮回到原始引用
    expect(endPos(segmentAt(timeline.segments, 2, 2), 'B')).toEqual([4, 3.8])
    expect(endPos(segmentAt(timeline.segments, 3, 2), 'B')).toEqual([16, 3.8])
  })

  it('swap 不挪动锥桶本身，只改引用', () => {
    const timeline = compileVariant(drill, 'var2')
    expect(timeline.objects.find((o) => o.id === 'left')?.pos).toEqual([4, 3])
    expect(timeline.objects.find((o) => o.id === 'right')?.pos).toEqual([16, 3])
  })

  it('setup 只在开头应用一次，第 2 轮从第 1 轮的终点接着跑', () => {
    const timeline = compileVariant(drill, 'var2')
    const round1End = endPos(segmentAt(timeline.segments, 0, 2), 'B')
    const round2Start = segmentAt(timeline.segments, 1, 0).actors.find(
      (m) => m.actorId === 'B',
    )!.points[0]!
    expect(round2Start).toEqual(round1End)
    // 若 setup 每轮重新应用，B 会瞬移回 [16, 3.8]
    expect(round2Start).not.toEqual([16, 3.8])
  })

  it('toward + stopShort 在距目标指定米数处停下', () => {
    const timeline = compileVariant(drill, 'var2')
    const mid: [number, number] = [10, 3]

    // 第 1 轮：从右锥桶 [16, 3.8] 朝中间锥桶跑，停在 2 米外
    const r1 = endPos(segmentAt(timeline.segments, 0, 0), 'B')
    expect(Math.hypot(r1[0] - mid[0], r1[1] - mid[1])).toBeCloseTo(2, 6)
    expect(r1[0]).toBeCloseTo(11.9825, 3)
    expect(r1[0]).toBeGreaterThan(10) // 在 A 的右侧

    // 第 2 轮：从左锥桶 [4, 3.8] 出发，镜像地停在左侧 2 米外
    const r2 = endPos(segmentAt(timeline.segments, 1, 0), 'B')
    expect(Math.hypot(r2[0] - mid[0], r2[1] - mid[1])).toBeCloseTo(2, 6)
    expect(r2[0]).toBeCloseTo(8.0175, 3)
    expect(r2[0]).toBeLessThan(10) // 在 A 的左侧
  })

  it('via 途经点被解析进路径，且平滑后依然精确经过它', () => {
    const timeline = compileVariant(drill, 'var2')
    const motion = segmentAt(timeline.segments, 0, 2).actors.find((m) => m.actorId === 'B')!
    // 平滑会把折线细分，所以不数点数，而是断言路点本身还在路径上：
    // 向心 Catmull-Rom 精确穿过每个路点，「跑到锥桶」不能被抄近道
    expect(motion.points).toContainEqual([10, 1.5]) // mid 上方 1.5 米
    expect(motion.points.length).toBeGreaterThan(3)
  })
})

describe('rotate：多人轮换', () => {
  const square = () => {
    const result = parseDrill(squareRaw)
    if (!result.ok) throw new Error('四角传球示例未通过校验')
    return result.drill
  }

  it('每轮把引用向后移一位，四轮后回到原位', () => {
    const timeline = compileVariant(square(), 'var1')
    // A 写的是「跑到 c2」，随着 rotate 每轮解析到下一个锥桶
    const aEnds = [0, 1, 2, 3].map((round) => endPos(segmentAt(timeline.segments, round, 4), 'A'))
    expect(aEnds).toEqual([
      [15, 5], // c2
      [15, 15], // c3
      [5, 15], // c4
      [5, 5], // c1，绕回原位
    ])
  })

  it('四人同时轮转，每轮结束时各就各位且互不重叠', () => {
    const timeline = compileVariant(square(), 'var1')
    for (let round = 0; round < 4; round++) {
      const last = segmentAt(timeline.segments, round, 4)
      const spots = ['A', 'B', 'C', 'D'].map((id) => endPos(last, id).join(','))
      expect(new Set(spots).size, `第 ${round + 1} 轮有人站到了同一点`).toBe(4)
    }
  })

  it('swap [a,b] 与 rotate [a,b] 编译结果完全相同', () => {
    const withSwap = structuredClone(drill)
    const withRotate = structuredClone(drill) as any
    const repeat = withRotate.variants[2].repeat
    repeat.rotate = [...repeat.swap]
    delete repeat.swap

    const parsed = parseDrill(withRotate)
    if (!parsed.ok) throw new Error('改成 rotate 后未通过校验')

    expect(compileVariant(parsed.drill, 'var2')).toEqual(compileVariant(withSwap, 'var2'))
  })
})

describe('球', () => {
  it('球全程跟着 A', () => {
    const timeline = compileVariant(drill, 'basic')
    for (const segment of timeline.segments) {
      const ball = segment.balls.find((b) => b.ballId === 'ball')!
      expect(ball.kind).toBe('withOwner')
      if (ball.kind === 'withOwner') expect(ball.ownerId).toBe('A')
    }
  })
})

describe('纯函数', () => {
  it('同一份输入编译两次结果完全相同', () => {
    expect(compileVariant(drill, 'var2')).toEqual(compileVariant(drill, 'var2'))
  })

  it('不修改传入的 drill', () => {
    const snapshot = structuredClone(drill)
    compileVariant(drill, 'var2')
    expect(drill).toEqual(snapshot)
  })
})

describe('连续跑动的连贯性（平滑 + 匀速）', () => {
  const drill = () => {
    const result = parseDrill(raw)
    if (!result.ok) throw new Error('示例未通过校验')
    return result.drill
  }

  it('B 连跑三个阶段，阶段边界处速度不会掉到 0', () => {
    const timeline = compileVariant(drill(), 'var2')
    const boundary = segmentAt(timeline.segments, 0, 0).endTime

    // 边界前后各取一小段，估计 B 的瞬时速度
    const speed = (at: number) => {
      const h = 0.02
      const a = sampleTimeline(timeline, at - h).actors.find((x) => x.id === 'B')!.pos
      const b = sampleTimeline(timeline, at + h).actors.find((x) => x.id === 'B')!.pos
      return Math.hypot(b[0] - a[0], b[1] - a[1]) / (2 * h)
    }

    // 以整段路线的平均速度作基准，边界处不该接近停住
    const reference = speed(boundary * 0.5)
    expect(speed(boundary)).toBeGreaterThan(reference * 0.4)
  })

  it('单独一段跑动仍然是起步加速、到点停住', () => {
    const timeline = compileVariant(drill(), 'basic')
    const segment = segmentAt(timeline.segments, 0, 0)
    const at = (t: number) => sampleTimeline(timeline, t).actors.find((x) => x.id === 'A')!.pos
    const h = 0.02

    const startSpeed = Math.hypot(...sub(at(segment.startTime + h), at(segment.startTime))) / h
    const midSpeed =
      Math.hypot(
        ...sub(at((segment.startTime + segment.endTime) / 2 + h), at((segment.startTime + segment.endTime) / 2)),
      ) / h
    expect(startSpeed).toBeLessThan(midSpeed * 0.5)
  })
})
