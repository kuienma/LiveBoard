import {
  isAbsolutePos,
  isRelativePos,
  type Action,
  type ActionType,
  type Actor,
  type Drill,
  type DrillObject,
  type Phase,
  type Vec2,
} from '@drill/schema'
import {
  clampToField,
  retargetPosition,
  staticPosOf,
  type NotDraggableReason,
} from './positionRef.js'

/** 历史记录上限。再多对手机内存不友好，实际也没人连撤 50 步。 */
const MAX_HISTORY = 50

export interface EditorState {
  drill: Drill
  past: Drill[]
  future: Drill[]
  /**
   * 正在进行的连续操作标识（比如拖动某个锥桶）。
   * 相同 mergeKey 的连续修改只占一条历史，否则撤销会一像素一像素地退。
   */
  mergeKey?: string
  /** 最近一次「不能这么改」的原因，用于给界面提示。 */
  lastRejection?: { reason: NotDraggableReason }
}

export type EditorAction =
  // 拖拽
  | { type: 'moveObject'; id: string; pos: Vec2 }
  | { type: 'moveSetup'; variantId: string; actorId: string; pos: Vec2 }
  | { type: 'moveActionTarget'; variantId: string; phaseIndex: number; actionIndex: number; pos: Vec2 }
  /** 手指抬起：结束合并，下一次修改会另起一条历史。 */
  | { type: 'endDrag' }
  // 属性
  | { type: 'patchObject'; id: string; patch: Partial<Omit<DrillObject, 'id'>> }
  | { type: 'patchActor'; id: string; patch: Partial<Omit<Actor, 'id'>> }
  | { type: 'patchMeta'; patch: Partial<Drill['meta']> }
  | { type: 'patchVariant'; variantId: string; patch: { name?: string; description?: string } }
  | { type: 'patchPhase'; variantId: string; phaseIndex: number; patch: Partial<Pick<Phase, 'duration' | 'slowMotion' | 'note'>> }
  | { type: 'setRepeatTimes'; variantId: string; times: number }
  // 增删
  | { type: 'addObject' }
  | { type: 'removeObject'; id: string }
  | { type: 'addActor'; role: Actor['role'] }
  | { type: 'removeActor'; id: string }
  | { type: 'addPhase'; variantId: string; afterIndex: number }
  | { type: 'removePhase'; variantId: string; phaseIndex: number }
  | { type: 'addAction'; variantId: string; phaseIndex: number; actorId: string; actionType: ActionType }
  | { type: 'removeAction'; variantId: string; phaseIndex: number; actionIndex: number }
  | { type: 'patchAction'; variantId: string; phaseIndex: number; actionIndex: number; patch: Record<string, unknown> }
  // 整体替换（JSON 高级入口、AI 修改）
  | { type: 'replaceDrill'; drill: Drill }
  | { type: 'undo' }
  | { type: 'redo' }

export function initEditor(drill: Drill): EditorState {
  return { drill: structuredClone(drill), past: [], future: [] }
}

export const canUndo = (state: EditorState) => state.past.length > 0
export const canRedo = (state: EditorState) => state.future.length > 0

/** 和保存基线比，判断有没有未保存的改动。 */
export function isDirty(state: EditorState, baseline: Drill): boolean {
  return JSON.stringify(state.drill) !== JSON.stringify(baseline)
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'undo': {
      const previous = state.past.at(-1)
      if (previous === undefined) return state
      return {
        drill: previous,
        past: state.past.slice(0, -1),
        future: [state.drill, ...state.future],
      }
    }
    case 'redo': {
      const next = state.future[0]
      if (next === undefined) return state
      return {
        drill: next,
        past: [...state.past, state.drill],
        future: state.future.slice(1),
      }
    }
    case 'endDrag': {
      if (state.mergeKey === undefined && state.lastRejection === undefined) return state
      const { mergeKey: _mergeKey, lastRejection: _rejection, ...rest } = state
      return rest
    }
    default:
      return mutate(state, action)
  }
}

/** 提交一次修改：压历史（除非在同一次连续操作里）、清空重做栈。 */
function commit(
  state: EditorState,
  next: Drill,
  mergeKey?: string,
): EditorState {
  const sameRun = mergeKey !== undefined && state.mergeKey === mergeKey
  const past = sameRun ? state.past : [...state.past, state.drill].slice(-MAX_HISTORY)

  return {
    drill: next,
    past,
    future: [],
    ...(mergeKey === undefined ? {} : { mergeKey }),
  }
}

function reject(state: EditorState, reason: NotDraggableReason): EditorState {
  return { ...state, lastRejection: { reason } }
}

function mutate(state: EditorState, action: EditorAction): EditorState {
  const drill = structuredClone(state.drill)

  switch (action.type) {
    case 'moveObject': {
      const object = drill.objects.find((item) => item.id === action.id)
      if (object === undefined) return state
      object.pos = clampToField(action.pos, drill)
      return commit(state, drill, `move:${action.id}`)
    }

    case 'moveSetup': {
      const variant = findVariant(drill, action.variantId)
      const ref = variant?.setup[action.actorId]
      if (variant === undefined || ref === undefined) return state

      const result = retargetPosition(ref, clampToField(action.pos, drill), drill)
      if (!result.ok) return reject(state, result.reason)

      variant.setup[action.actorId] = result.ref
      return commit(state, drill, `setup:${action.variantId}:${action.actorId}`)
    }

    case 'moveActionTarget': {
      const phase = findPhase(drill, action.variantId, action.phaseIndex)
      const target = phase?.actions[action.actionIndex]
      if (phase === undefined || target === undefined) return state
      if (target.type !== 'run' && target.type !== 'dribble' && target.type !== 'shoot') {
        return state
      }

      const result = retargetPosition(target.to, clampToField(action.pos, drill), drill)
      if (!result.ok) return reject(state, result.reason)

      target.to = result.ref
      return commit(
        state,
        drill,
        `action:${action.variantId}:${action.phaseIndex}:${action.actionIndex}`,
      )
    }

    case 'patchObject': {
      const object = drill.objects.find((item) => item.id === action.id)
      if (object === undefined) return state
      Object.assign(object, action.patch)
      return commit(state, drill)
    }

    case 'patchActor': {
      const actor = drill.actors.find((item) => item.id === action.id)
      if (actor === undefined) return state
      Object.assign(actor, action.patch)
      return commit(state, drill)
    }

    case 'patchMeta': {
      Object.assign(drill.meta, action.patch)
      return commit(state, drill)
    }

    case 'patchVariant': {
      const variant = findVariant(drill, action.variantId)
      if (variant === undefined) return state
      if (action.patch.name !== undefined) variant.name = action.patch.name
      if (action.patch.description !== undefined) variant.description = action.patch.description
      return commit(state, drill)
    }

    case 'patchPhase': {
      const phase = findPhase(drill, action.variantId, action.phaseIndex)
      if (phase === undefined) return state
      Object.assign(phase, action.patch)
      return commit(state, drill)
    }

    case 'setRepeatTimes': {
      const variant = findVariant(drill, action.variantId)
      if (variant === undefined) return state
      const times = Math.max(1, Math.round(action.times))
      variant.repeat = { ...(variant.repeat ?? { times }), times }
      return commit(state, drill)
    }

    case 'addObject': {
      const id = uniqueId(drill, 'cone')
      drill.objects.push({
        id,
        type: 'cone',
        color: 'orange',
        size: 'short',
        // 放在场地中心，用户接着拖到想要的位置
        pos: [round1(drill.field.width / 2), round1(drill.field.height / 2)],
      })
      return commit(state, drill)
    }

    case 'removeObject': {
      drill.objects = drill.objects.filter((item) => item.id !== action.id)
      return commit(state, drill)
    }

    case 'addActor': {
      const id = uniqueId(drill, action.role === 'coach' ? 'coach' : 'P')
      const actor: Actor = {
        id,
        role: action.role,
        label: id.slice(0, 3),
        ...(action.role === 'coach' ? { pos: [round1(drill.field.width - 2), round1(drill.field.height - 2)] as Vec2 } : {}),
      }
      drill.actors.push(actor)
      // 非教练要在每个练法里有初始站位，否则过不了校验
      if (action.role !== 'coach') {
        for (const variant of drill.variants) {
          variant.setup[id] = [round1(drill.field.width / 2), round1(drill.field.height / 2) + 2]
        }
      }
      return commit(state, drill)
    }

    case 'removeActor': {
      // 站位马上要被删掉，落点先算出来
      const dropAt = droppedBallPos(drill, action.id)
      drill.actors = drill.actors.filter((item) => item.id !== action.id)
      for (const variant of drill.variants) {
        delete variant.setup[action.id]
        for (const phase of variant.phases) {
          phase.actions = phase.actions.filter((item) => item.actor !== action.id)
        }
      }
      // 球归属指向被删球员时也要清掉，否则校验会报。
      // 落点优先取这名球员原来的起始位置：丢到场地正中会让画面突然
      // 冒出一个和练法无关的球，不如留在它本来在的地方。
      for (const ball of drill.balls) {
        if (ball.owner === action.id) {
          delete ball.owner
          ball.pos = dropAt ?? [round1(drill.field.width / 2), round1(drill.field.height / 2)]
        }
      }
      return commit(state, drill)
    }

    case 'addPhase': {
      const variant = findVariant(drill, action.variantId)
      if (variant === undefined) return state
      variant.phases.splice(action.afterIndex + 1, 0, {
        duration: 1.5,
        slowMotion: false,
        actions: [],
      })
      return commit(state, drill)
    }

    case 'removePhase': {
      const variant = findVariant(drill, action.variantId)
      if (variant === undefined || variant.phases.length <= 1) return state
      variant.phases.splice(action.phaseIndex, 1)
      return commit(state, drill)
    }

    case 'addAction': {
      const phase = findPhase(drill, action.variantId, action.phaseIndex)
      if (phase === undefined) return state
      if (phase.actions.some((item) => item.actor === action.actorId)) return state

      const created = makeAction(drill, action.actorId, action.actionType)
      if (created === undefined) return state
      phase.actions.push(created)
      return commit(state, drill)
    }

    case 'removeAction': {
      const phase = findPhase(drill, action.variantId, action.phaseIndex)
      if (phase === undefined) return state
      phase.actions.splice(action.actionIndex, 1)
      return commit(state, drill)
    }

    case 'patchAction': {
      const phase = findPhase(drill, action.variantId, action.phaseIndex)
      const target = phase?.actions[action.actionIndex]
      if (target === undefined) return state
      Object.assign(target, action.patch)
      return commit(state, drill)
    }

    case 'replaceDrill': {
      return commit(state, structuredClone(action.drill))
    }

    default:
      return state
  }
}

function findVariant(drill: Drill, variantId: string) {
  return drill.variants.find((variant) => variant.id === variantId)
}

function findPhase(drill: Drill, variantId: string, phaseIndex: number) {
  return findVariant(drill, variantId)?.phases[phaseIndex]
}

const round1 = (value: number) => Math.round(value * 10) / 10

/** 生成不与现有 id 冲突的新 id（所有 id 共享命名空间）。 */
export function uniqueId(drill: Drill, prefix: string): string {
  const taken = new Set([
    ...drill.objects.map((item) => item.id),
    ...drill.actors.map((item) => item.id),
    ...drill.balls.map((item) => item.id),
  ])
  if (!taken.has(prefix)) return prefix
  for (let i = 2; ; i++) {
    const candidate = `${prefix}${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/** 新增动作时给一个合理的默认值，用户不必手写坐标。 */
function makeAction(drill: Drill, actorId: string, type: ActionType): Action | undefined {
  const anchor = drill.objects[0]?.id
  const center: Vec2 = [round1(drill.field.width / 2), round1(drill.field.height / 2)]
  const to = anchor === undefined ? center : { at: anchor, offset: [0, 0] as Vec2 }

  switch (type) {
    case 'run':
    case 'dribble':
      return { type, actor: actorId, to }
    case 'turn':
      return { type, actor: actorId, degrees: 180 }
    case 'pass': {
      const other = drill.actors.find(
        (actor) => actor.id !== actorId && actor.role !== 'coach',
      )
      return other === undefined ? undefined : { type, actor: actorId, to: other.id }
    }
    case 'shoot':
      return { type, actor: actorId, to: center }
    case 'wait':
      return { type, actor: actorId }
  }
}

export const ACTION_TYPE_LABEL: Record<ActionType, string> = {
  run: '跑动（无球）',
  dribble: '带球跑',
  turn: '转身',
  pass: '传球',
  shoot: '射门',
  wait: '原地不动',
}

/**
 * 删掉持球球员时，球该落在哪。
 *
 * 取这名球员在任一练法里能直接确定的起始位置；相对别人定位的（会移动的基准点）
 * 没法在不跑引擎的情况下算出来，交给调用方兜底。
 */
function droppedBallPos(drill: Drill, actorId: string): Vec2 | undefined {
  const own = drill.actors.find((actor) => actor.id === actorId)?.pos
  if (own !== undefined) return [...own]

  for (const variant of drill.variants) {
    const ref = variant.setup[actorId]
    if (ref === undefined) continue
    if (isAbsolutePos(ref)) return [...ref]
    if (isRelativePos(ref)) {
      const base = staticPosOf(drill, ref.at)
      if (base === undefined) continue
      const [dx, dy] = ref.offset ?? [0, 0]
      return [round1(base[0] + dx), round1(base[1] + dy)]
    }
  }
  return undefined
}
