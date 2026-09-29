import { compileVariant, sampleTimeline, type Timeline } from '@drill/engine'
import { parseDrill, type Drill } from '@drill/schema'
import { beforeAll, describe, expect, it } from 'vitest'
import raw from '../../../../fixtures/side-attack.json'
import { buildHandles, keyframeTime, type Handle, type Keyframe } from './handles.js'

let drill: Drill
const timelines = new Map<string, Timeline>()

beforeAll(() => {
  const result = parseDrill(raw)
  if (!result.ok) throw new Error('示例数据未通过校验')
  drill = result.drill
  for (const variant of drill.variants) {
    timelines.set(variant.id, compileVariant(drill, variant.id))
  }
})

const handlesFor = (variantId: string, keyframe: Keyframe): Handle[] => {
  const timeline = timelines.get(variantId)!
  const frame = sampleTimeline(timeline, keyframeTime(timeline, keyframe))
  return buildHandles(drill, variantId, keyframe, frame)
}

const byKey = (handles: Handle[], key: string) => handles.find((h) => h.key === key)!

describe('关键帧时刻', () => {
  it('起始站位取 0', () => {
    expect(keyframeTime(timelines.get('basic')!, { kind: 'setup' })).toBe(0)
  })

  it('阶段取该阶段结束前一瞬，且只看第一轮', () => {
    const timeline = timelines.get('basic')!
    // 第一轮三个阶段 2.4 / 0.9 / 2.4
    expect(keyframeTime(timeline, { kind: 'phase', index: 0 })).toBeCloseTo(2.4, 3)
    expect(keyframeTime(timeline, { kind: 'phase', index: 1 })).toBeCloseTo(3.3, 3)
    expect(keyframeTime(timeline, { kind: 'phase', index: 2 })).toBeCloseTo(5.7, 3)
  })

  it('取的时刻确实落在对应阶段内，不会串到下一段', () => {
    const timeline = timelines.get('basic')!
    for (const index of [0, 1, 2]) {
      const frame = sampleTimeline(timeline, keyframeTime(timeline, { kind: 'phase', index }))
      expect(frame.phaseIndex).toBe(index)
      expect(frame.roundIndex).toBe(0)
    }
  })
})

describe('起始站位关键帧', () => {
  const handles = () => handlesFor('basic', { kind: 'setup' })

  it('所有器材都能拖，改 objects[].pos', () => {
    for (const id of ['start', 'mid', 'left', 'right']) {
      expect(byKey(handles(), `object:${id}`).target).toEqual({ kind: 'object', id })
    }
  })

  it('setup 里的球员改 setup', () => {
    expect(byKey(handles(), 'actor:A').target).toEqual({ kind: 'setup', actorId: 'A' })
    expect(byKey(handles(), 'actor:B').target).toEqual({ kind: 'setup', actorId: 'B' })
  })

  it('教练用固定 pos，直接改 actors[].pos', () => {
    expect(byKey(handles(), 'actor:coach').target).toEqual({ kind: 'object', id: 'coach' })
  })

  it('手柄位置就是画面上的位置', () => {
    // A 的 setup 是 start[10,13] + [0,-0.6]
    expect(byKey(handles(), 'actor:A').pos).toEqual([10, 12.4])
    expect(byKey(handles(), 'object:mid').pos).toEqual([10, 3])
  })

  it('标签取球员的 label', () => {
    expect(byKey(handles(), 'actor:A').label).toBe('A')
  })
})

describe('阶段关键帧', () => {
  it('有跑动/带球动作的球员改那个动作的 to', () => {
    const handles = handlesFor('basic', { kind: 'phase', index: 0 })
    expect(byKey(handles, 'actor:A').target).toEqual({
      kind: 'action',
      phaseIndex: 0,
      actionIndex: 0,
    })
    expect(byKey(handles, 'actor:B').target).toEqual({
      kind: 'action',
      phaseIndex: 0,
      actionIndex: 1,
    })
  })

  it('转身动作没有终点，不能拖，且原因不是「没有动作」', () => {
    const handles = handlesFor('basic', { kind: 'phase', index: 1 })
    const a = byKey(handles, 'actor:A')
    expect(a.target).toBeUndefined()
    // A 在这一阶段是有动作（转身）的，说成 no-action 会把人引去加动作
    expect(a.reason).toBe('no-endpoint')
  })

  it('toward + stopShort 的终点不能拖，给出专门的原因', () => {
    // 变化二第一阶段 B 是 { toward: mid, stopShort: 2 }
    const handles = handlesFor('var2', { kind: 'phase', index: 0 })
    const b = byKey(handles, 'actor:B')
    expect(b.target).toBeUndefined()
    expect(b.reason).toBe('toward')
  })

  it('本阶段没有动作的球员不能拖', () => {
    const handles = handlesFor('basic', { kind: 'phase', index: 0 })
    const coachHandle = byKey(handles, 'actor:coach')
    // 教练有固定 pos，所以仍然可拖（改的是 actors[].pos）
    expect(coachHandle.target).toEqual({ kind: 'object', id: 'coach' })
  })

  it('器材在任何阶段都能拖', () => {
    for (const index of [0, 1, 2]) {
      const handles = handlesFor('basic', { kind: 'phase', index })
      expect(byKey(handles, 'object:mid').target).toEqual({ kind: 'object', id: 'mid' })
    }
  })

  it('手柄位置是该阶段结束时的位置', () => {
    const handles = handlesFor('basic', { kind: 'phase', index: 0 })
    // 第一阶段结束 A 到 mid[10,3] + [0,1.2]
    const a = byKey(handles, 'actor:A')
    expect(a.pos[0]).toBeCloseTo(10, 1)
    expect(a.pos[1]).toBeCloseTo(4.2, 1)
  })
})

describe('每个可见对象都有手柄', () => {
  it('数量 = 器材 + 球员', () => {
    const handles = handlesFor('basic', { kind: 'setup' })
    expect(handles).toHaveLength(drill.objects.length + drill.actors.length)
  })

  it('key 唯一', () => {
    const handles = handlesFor('basic', { kind: 'setup' })
    expect(new Set(handles.map((h) => h.key)).size).toBe(handles.length)
  })
})
