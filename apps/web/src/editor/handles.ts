import type { FrameState, Timeline } from '@drill/engine'
import { isTowardPos, type Drill, type Vec2 } from '@drill/schema'
import type { NotDraggableReason } from './positionRef.js'
import { staticPosOf } from './positionRef.js'

/** 编辑哪一个关键帧：练法的起始站位，或某个阶段结束时的状态。 */
export type Keyframe = { kind: 'setup' } | { kind: 'phase'; index: number }

export type HandleTarget =
  /** 改 objects[].pos。器材的位置和阶段无关，任何关键帧下都能拖。 */
  | { kind: 'object'; id: string }
  /** 改 variants[].setup[actorId]。 */
  | { kind: 'setup'; actorId: string }
  /** 改某个动作的 to。 */
  | { kind: 'action'; phaseIndex: number; actionIndex: number }

export interface Handle {
  /** 稳定的 key，供 React 用。 */
  key: string
  /** 场地坐标（米）。 */
  pos: Vec2
  label: string
  /** 器材还是球员，决定手柄样式。 */
  kind: 'object' | 'actor'
  /** 可拖时给出改哪里；不可拖时给出原因。 */
  target?: HandleTarget
  reason?: NotDraggableReason | HandleBlockReason
}

/** 手柄自身的阻拦原因（和「位置写法不可拖」区分开）。 */
export type HandleBlockReason = 'no-action' | 'no-endpoint'

export const HANDLE_BLOCK_LABEL: Record<HandleBlockReason, string> = {
  'no-action': '这个球员在本阶段没有动作，拖不了。可以在下面「添加动作」。',
  // 和 no-action 分开：这两种情况该做的事完全不同，说成「没有动作」
  // 会让人去加动作，而同一阶段同一人加第二个动作是会被规则拒掉的
  'no-endpoint': '这一步是转身 / 传球 / 原地不动，没有可拖的终点。改动作类型或在下面调参数。',
}

/** 关键帧对应的采样时刻：起始站位取 0，阶段取该阶段结束前的一瞬。 */
export function keyframeTime(timeline: Timeline, keyframe: Keyframe): number {
  if (keyframe.kind === 'setup') return 0

  // 只看第一轮：setup 和动作都是写一次的，后面几轮是重复或 swap 的结果
  const segment = timeline.segments.find(
    (item) => item.roundIndex === 0 && item.phaseIndex === keyframe.index,
  )
  if (segment === undefined) return 0
  // 取结束前一瞬：正好等于 endTime 会落到下一段
  return Math.max(0, segment.endTime - 1e-4)
}

/**
 * 算出当前关键帧下每个可见对象的手柄，以及拖它会改哪个字段。
 *
 * 这一层刻意做成纯函数：「谁能拖、拖了改哪里」的判定依赖关键帧和动作类型，
 * 在 UI 里调试代价高。
 */
export function buildHandles(
  drill: Drill,
  variantId: string,
  keyframe: Keyframe,
  frame: FrameState,
): Handle[] {
  const handles: Handle[] = []

  for (const object of drill.objects) {
    handles.push({
      key: `object:${object.id}`,
      pos: object.pos,
      label: object.id,
      kind: 'object',
      target: { kind: 'object', id: object.id },
    })
  }

  const variant = drill.variants.find((item) => item.id === variantId)

  for (const actorFrame of frame.actors) {
    const actor = drill.actors.find((item) => item.id === actorFrame.id)
    const label = actor?.label ?? actorFrame.id
    const base: Omit<Handle, 'target' | 'reason'> = {
      key: `actor:${actorFrame.id}`,
      pos: actorFrame.pos,
      label,
      kind: 'actor',
    }

    // 有固定 pos 的（通常是教练）在任何关键帧下都直接改 actors[].pos
    if (staticPosOf(drill, actorFrame.id) !== undefined && variant?.setup[actorFrame.id] === undefined) {
      handles.push({ ...base, target: { kind: 'object', id: actorFrame.id } })
      continue
    }

    if (keyframe.kind === 'setup') {
      const ref = variant?.setup[actorFrame.id]
      if (ref === undefined) {
        handles.push({ ...base, reason: 'unknown-base' })
      } else if (isTowardPos(ref)) {
        handles.push({ ...base, reason: 'toward' })
      } else {
        handles.push({ ...base, target: { kind: 'setup', actorId: actorFrame.id } })
      }
      continue
    }

    const phase = variant?.phases[keyframe.index]
    const actionIndex =
      phase?.actions.findIndex((item) => item.actor === actorFrame.id) ?? -1
    const action = actionIndex === -1 ? undefined : phase?.actions[actionIndex]

    if (action === undefined) {
      handles.push({ ...base, reason: 'no-action' })
      continue
    }
    if (action.type !== 'run' && action.type !== 'dribble' && action.type !== 'shoot') {
      // 转身、传球、原地不动都没有可拖的终点
      handles.push({ ...base, reason: 'no-endpoint' })
      continue
    }
    if (isTowardPos(action.to)) {
      handles.push({ ...base, reason: 'toward' })
      continue
    }

    handles.push({
      ...base,
      target: { kind: 'action', phaseIndex: keyframe.index, actionIndex },
    })
  }

  return handles
}
