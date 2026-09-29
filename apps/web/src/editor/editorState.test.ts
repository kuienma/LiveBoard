import { parseDrill, type Drill } from '@drill/schema'
import { beforeAll, describe, expect, it } from 'vitest'
import raw from '../../../../fixtures/side-attack.json'
import {
  canRedo,
  canUndo,
  editorReducer,
  initEditor,
  isDirty,
  uniqueId,
  type EditorAction,
  type EditorState,
} from './editorState.js'
import { retargetPosition } from './positionRef.js'

let base: Drill

beforeAll(() => {
  const result = parseDrill(raw)
  if (!result.ok) throw new Error('示例数据未通过校验')
  base = result.drill
})

const start = () => initEditor(base)

/** 连续 dispatch，方便写用例。 */
const run = (state: EditorState, ...actions: EditorAction[]): EditorState =>
  actions.reduce(editorReducer, state)

/** 改动后仍必须通过同一套校验（阶段三验收项）。 */
const expectValid = (state: EditorState) => {
  const result = parseDrill(state.drill)
  if (!result.ok) {
    throw new Error(result.issues.map((i) => `${i.path}: ${i.message}`).join('\n'))
  }
}

describe('拖动器材', () => {
  it('改锥桶坐标并保留一位小数', () => {
    const next = run(start(), { type: 'moveObject', id: 'mid', pos: [11.234, 5.678] })
    expect(next.drill.objects.find((o) => o.id === 'mid')!.pos).toEqual([11.2, 5.7])
    expectValid(next)
  })

  it('拖出场地会贴边', () => {
    const next = run(start(), { type: 'moveObject', id: 'mid', pos: [-5, 99] })
    expect(next.drill.objects.find((o) => o.id === 'mid')!.pos).toEqual([0, 15])
  })

  it('把锥桶拖到角上会让相对它定位的动作终点越界，由实时校验拦住保存', () => {
    // 这是有意的行为：只夹被拖的对象自己，不连带夹紧依赖项，
    // 否则会出现「我明明拖到这里，它却跑到别处」。
    const next = run(start(), { type: 'moveObject', id: 'mid', pos: [10, 15] })
    const result = parseDrill(next.drill)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.message.includes('超出场地范围'))).toBe(true)
  })

  it('一次拖动只占一条历史，撤销直接回到拖动前', () => {
    let state = start()
    const before = state.drill.objects.find((o) => o.id === 'mid')!.pos

    // 模拟手指移动过程中的连续事件
    for (let x = 10; x <= 14; x++) {
      state = editorReducer(state, { type: 'moveObject', id: 'mid', pos: [x, 3] })
    }
    state = editorReducer(state, { type: 'endDrag' })
    expect(state.past).toHaveLength(1)

    state = editorReducer(state, { type: 'undo' })
    expect(state.drill.objects.find((o) => o.id === 'mid')!.pos).toEqual(before)
  })

  it('两次独立拖动是两条历史', () => {
    let state = start()
    state = run(state, { type: 'moveObject', id: 'mid', pos: [11, 3] }, { type: 'endDrag' })
    state = run(state, { type: 'moveObject', id: 'left', pos: [5, 3] }, { type: 'endDrag' })
    expect(state.past).toHaveLength(2)
  })
})

describe('拖动球员：保持位置引用的形式', () => {
  it('相对锥桶的站位拖动后仍是相对的，只改 offset', () => {
    // A 的初始站位是 { at: "start", offset: [0, -0.6] }，start 在 [10, 13]
    const next = run(start(), {
      type: 'moveSetup',
      variantId: 'basic',
      actorId: 'A',
      pos: [11, 12],
    })
    expect(next.drill.variants[0]!.setup['A']).toEqual({ at: 'start', offset: [1, -1] })
    expectValid(next)
  })

  it('保持相对意味着挪动锥桶后球员会跟着走', () => {
    let state = run(start(), {
      type: 'moveSetup',
      variantId: 'basic',
      actorId: 'A',
      pos: [11, 12],
    })
    state = run(state, { type: 'endDrag' }, { type: 'moveObject', id: 'start', pos: [6, 13] })
    // A 的 offset 没变，基准点变了，所以 A 跟着平移
    expect(state.drill.variants[0]!.setup['A']).toEqual({ at: 'start', offset: [1, -1] })
  })

  it('动作终点也保形', () => {
    const next = run(start(), {
      type: 'moveActionTarget',
      variantId: 'basic',
      phaseIndex: 0,
      actionIndex: 0, // A dribble to { at: mid, offset: [0, 1.2] }
      pos: [10.5, 5],
    })
    const action = next.drill.variants[0]!.phases[0]!.actions[0]!
    // mid 在 [10, 4]... 实际 fixture 里是 [10, 3]
    expect(action).toMatchObject({ to: { at: 'mid', offset: [0.5, 2] } })
    expectValid(next)
  })

  it('toward + stopShort 的终点不能拖，并给出原因', () => {
    // 变化二第一阶段 B 用的是 { toward: "mid", stopShort: 2 }
    const next = run(start(), {
      type: 'moveActionTarget',
      variantId: 'var2',
      phaseIndex: 0,
      actionIndex: 1,
      pos: [12, 5],
    })
    expect(next.lastRejection?.reason).toBe('toward')
    // 数据没被改动，也没压历史
    expect(next.drill).toEqual(base)
    expect(next.past).toHaveLength(0)
  })

  it('转身动作没有终点，拖它不做任何事', () => {
    const next = run(start(), {
      type: 'moveActionTarget',
      variantId: 'basic',
      phaseIndex: 1,
      actionIndex: 0, // turn
      pos: [12, 5],
    })
    expect(next.drill).toEqual(base)
  })
})

describe('retargetPosition 单独验一遍', () => {
  it('绝对坐标保持绝对', () => {
    const result = retargetPosition([1, 2], [3.44, 4.55], base)
    expect(result).toEqual({ ok: true, ref: [3.4, 4.6] })
  })

  it('相对不存在的基准点时拒绝', () => {
    const result = retargetPosition({ at: 'A', offset: [0, 0] }, [3, 4], base)
    // A 是参与动作的球员，没有固定 pos，基准点随时间变
    expect(result).toEqual({ ok: false, reason: 'unknown-base' })
  })
})

describe('属性修改', () => {
  it('改锥桶颜色和高矮', () => {
    const next = run(start(), {
      type: 'patchObject',
      id: 'left',
      patch: { color: 'blue', size: 'tall' },
    })
    const object = next.drill.objects.find((o) => o.id === 'left')!
    expect(object.color).toBe('blue')
    expect(object.size).toBe('tall')
    expectValid(next)
  })

  it('改球员标签', () => {
    const next = run(start(), { type: 'patchActor', id: 'B', patch: { label: '守' } })
    expect(next.drill.actors.find((a) => a.id === 'B')!.label).toBe('守')
    expectValid(next)
  })

  it('改标题与练法名称、说明', () => {
    let state = run(start(), { type: 'patchMeta', patch: { title: '新标题' } })
    state = run(state, {
      type: 'patchVariant',
      variantId: 'basic',
      patch: { name: '新练法名', description: '新说明' },
    })
    expect(state.drill.meta.title).toBe('新标题')
    expect(state.drill.variants[0]!.name).toBe('新练法名')
    expect(state.drill.variants[0]!.description).toBe('新说明')
    expectValid(state)
  })

  it('改阶段时长与慢放', () => {
    const next = run(start(), {
      type: 'patchPhase',
      variantId: 'basic',
      phaseIndex: 0,
      patch: { duration: 3.5, slowMotion: true },
    })
    const phase = next.drill.variants[0]!.phases[0]!
    expect(phase.duration).toBe(3.5)
    expect(phase.slowMotion).toBe(true)
    expectValid(next)
  })

  it('改轮数，最少 1 轮', () => {
    expect(
      run(start(), { type: 'setRepeatTimes', variantId: 'basic', times: 6 }).drill.variants[0]!
        .repeat!.times,
    ).toBe(6)
    expect(
      run(start(), { type: 'setRepeatTimes', variantId: 'basic', times: 0 }).drill.variants[0]!
        .repeat!.times,
    ).toBe(1)
  })

  it('改轮数不会碰掉 swap', () => {
    const next = run(start(), { type: 'setRepeatTimes', variantId: 'var2', times: 6 })
    expect(next.drill.variants[2]!.repeat).toEqual({ times: 6, swap: ['left', 'right'] })
    expectValid(next)
  })
})

describe('增删器材与球员', () => {
  it('加锥桶：放在场地中心，id 不冲突', () => {
    const next = run(start(), { type: 'addObject' })
    expect(next.drill.objects).toHaveLength(5)
    expect(next.drill.objects.at(-1)!.pos).toEqual([10, 7.5])
    expectValid(next)
  })

  it('连加多个锥桶 id 递增', () => {
    const next = run(start(), { type: 'addObject' }, { type: 'addObject' })
    const ids = next.drill.objects.map((o) => o.id)
    expect(ids).toContain('cone')
    expect(ids).toContain('cone2')
  })

  it('删掉被引用的锥桶会让数据变不合法——界面必须阻止保存', () => {
    const next = run(start(), { type: 'removeObject', id: 'mid' })
    const result = parseDrill(next.drill)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.message.includes('不存在的 id「mid」'))).toBe(true)
  })

  it('加球员会自动在每个练法里补初始站位，否则过不了校验', () => {
    const next = run(start(), { type: 'addActor', role: 'attacker' })
    expectValid(next)
    for (const variant of next.drill.variants) {
      expect(variant.setup['P']).toBeDefined()
    }
  })

  it('加教练用固定 pos，不进 setup', () => {
    const next = run(start(), { type: 'addActor', role: 'coach' })
    const added = next.drill.actors.at(-1)!
    expect(added.pos).toBeDefined()
    expect(next.drill.variants[0]!.setup[added.id]).toBeUndefined()
    expectValid(next)
  })

  it('删球员会连带清掉站位、动作和球的归属，保持数据合法', () => {
    const next = run(start(), { type: 'removeActor', id: 'A' })
    expectValid(next)

    for (const variant of next.drill.variants) {
      expect(variant.setup['A']).toBeUndefined()
      for (const phase of variant.phases) {
        expect(phase.actions.some((a) => a.actor === 'A')).toBe(false)
      }
    }
    // 球原来归 A，现在要落到场上而不是悬空
    expect(next.drill.balls[0]!.owner).toBeUndefined()
    // 而且落在 A 原来站的地方（相对 start 锥桶算出来），不是场地正中
    expect(next.drill.balls[0]!.pos).toEqual([10, 12.4])
  })
})

describe('增删阶段与动作', () => {
  it('在指定阶段后面插入新阶段', () => {
    const next = run(start(), { type: 'addPhase', variantId: 'basic', afterIndex: 0 })
    const phases = next.drill.variants[0]!.phases
    expect(phases).toHaveLength(4)
    expect(phases[1]!.duration).toBe(1.5)
    expect(phases[1]!.actions).toHaveLength(0)
    expectValid(next)
  })

  it('删阶段', () => {
    const next = run(start(), { type: 'removePhase', variantId: 'basic', phaseIndex: 1 })
    expect(next.drill.variants[0]!.phases).toHaveLength(2)
    expectValid(next)
  })

  it('不允许删掉最后一个阶段（练法至少要有一个阶段）', () => {
    let state = start()
    state = run(state, { type: 'removePhase', variantId: 'basic', phaseIndex: 0 })
    state = run(state, { type: 'removePhase', variantId: 'basic', phaseIndex: 0 })
    expect(state.drill.variants[0]!.phases).toHaveLength(1)
    const blocked = run(state, { type: 'removePhase', variantId: 'basic', phaseIndex: 0 })
    expect(blocked.drill.variants[0]!.phases).toHaveLength(1)
    expectValid(blocked)
  })

  it('加动作时给合理默认值，不用手写坐标', () => {
    const next = run(
      start(),
      { type: 'addPhase', variantId: 'basic', afterIndex: 2 },
      { type: 'addAction', variantId: 'basic', phaseIndex: 3, actorId: 'B', actionType: 'run' },
    )
    const added = next.drill.variants[0]!.phases[3]!.actions[0]!
    expect(added).toMatchObject({ actor: 'B', type: 'run', to: { at: 'start', offset: [0, 0] } })
    expectValid(next)
  })

  it('同一阶段同一球员不能加第二个动作（会违反同时发生的语义）', () => {
    const next = run(start(), {
      type: 'addAction',
      variantId: 'basic',
      phaseIndex: 0,
      actorId: 'A',
      actionType: 'wait',
    })
    expect(next.drill.variants[0]!.phases[0]!.actions).toHaveLength(2)
  })

  it('加传球动作会自动挑一个接球人', () => {
    const next = run(
      start(),
      { type: 'addPhase', variantId: 'basic', afterIndex: 2 },
      { type: 'addAction', variantId: 'basic', phaseIndex: 3, actorId: 'A', actionType: 'pass' },
    )
    expect(next.drill.variants[0]!.phases[3]!.actions[0]).toMatchObject({ type: 'pass', to: 'B' })
  })

  it('删动作', () => {
    const next = run(start(), {
      type: 'removeAction',
      variantId: 'basic',
      phaseIndex: 0,
      actionIndex: 1,
    })
    expect(next.drill.variants[0]!.phases[0]!.actions).toHaveLength(1)
  })

  it('改动作属性（转身角度）', () => {
    const next = run(start(), {
      type: 'patchAction',
      variantId: 'basic',
      phaseIndex: 1,
      actionIndex: 0,
      patch: { degrees: 90 },
    })
    expect(next.drill.variants[0]!.phases[1]!.actions[0]).toMatchObject({ degrees: 90 })
    expectValid(next)
  })
})

describe('撤销与重做', () => {
  it('撤销回到上一步，重做再回来', () => {
    let state = run(start(), { type: 'patchMeta', patch: { title: '改过' } })
    expect(canUndo(state)).toBe(true)
    expect(canRedo(state)).toBe(false)

    state = editorReducer(state, { type: 'undo' })
    expect(state.drill.meta.title).toBe('从侧边进攻')
    expect(canRedo(state)).toBe(true)

    state = editorReducer(state, { type: 'redo' })
    expect(state.drill.meta.title).toBe('改过')
  })

  it('撤销到底后再撤销无副作用', () => {
    const state = editorReducer(start(), { type: 'undo' })
    expect(state.drill).toEqual(base)
    expect(canUndo(state)).toBe(false)
  })

  it('撤销后再改动会清掉重做栈', () => {
    let state = run(start(), { type: 'patchMeta', patch: { title: 'A' } })
    state = editorReducer(state, { type: 'undo' })
    state = run(state, { type: 'patchMeta', patch: { title: 'B' } })
    expect(canRedo(state)).toBe(false)
    expect(state.drill.meta.title).toBe('B')
  })

  it('多步撤销', () => {
    let state = start()
    for (const title of ['一', '二', '三']) {
      state = run(state, { type: 'patchMeta', patch: { title } })
    }
    state = run(state, { type: 'undo' }, { type: 'undo' })
    expect(state.drill.meta.title).toBe('一')
  })

  it('历史不会无限增长', () => {
    let state = start()
    for (let i = 0; i < 80; i++) {
      state = run(state, { type: 'patchMeta', patch: { title: `第 ${i} 版` } })
    }
    expect(state.past.length).toBeLessThanOrEqual(50)
  })
})

describe('整体替换与脏标记', () => {
  it('replaceDrill 可撤销（JSON 高级入口靠它）', () => {
    const edited = structuredClone(base)
    edited.meta.title = '整体替换'
    let state = run(start(), { type: 'replaceDrill', drill: edited })
    expect(state.drill.meta.title).toBe('整体替换')
    state = editorReducer(state, { type: 'undo' })
    expect(state.drill.meta.title).toBe('从侧边进攻')
  })

  it('isDirty 对比保存基线', () => {
    const state = start()
    expect(isDirty(state, base)).toBe(false)
    const changed = run(state, { type: 'patchMeta', patch: { title: '改了' } })
    expect(isDirty(changed, base)).toBe(true)
    expect(isDirty(editorReducer(changed, { type: 'undo' }), base)).toBe(false)
  })

  it('初始化会深拷贝，改编辑态不会污染原对象', () => {
    const state = run(start(), { type: 'moveObject', id: 'mid', pos: [1, 1] })
    expect(base.objects.find((o) => o.id === 'mid')!.pos).not.toEqual([1, 1])
    expect(state.drill.objects.find((o) => o.id === 'mid')!.pos).toEqual([1, 1])
  })
})

describe('uniqueId', () => {
  it('避开所有已用 id（器材、球员、球共享命名空间）', () => {
    expect(uniqueId(base, 'mid')).toBe('mid2')
    expect(uniqueId(base, 'A')).toBe('A2')
    expect(uniqueId(base, 'ball')).toBe('ball2')
    expect(uniqueId(base, 'brandnew')).toBe('brandnew')
  })
})
