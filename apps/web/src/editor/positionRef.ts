import {
  isAbsolutePos,
  isRelativePos,
  isTowardPos,
  type Drill,
  type PositionRef,
  type Vec2,
} from '@drill/schema'

/** 查一个 id 的静态位置（器材有 pos，球员可能有固定 pos）。 */
export function staticPosOf(drill: Drill, id: string): Vec2 | undefined {
  return (
    drill.objects.find((object) => object.id === id)?.pos ??
    drill.actors.find((actor) => actor.id === id)?.pos
  )
}

/** 为什么某个位置不能拖，给界面显示。 */
export type NotDraggableReason = 'toward' | 'unknown-base'

export type RetargetResult =
  | { ok: true; ref: PositionRef }
  | { ok: false; reason: NotDraggableReason }

/**
 * 把一个位置引用「移到」新坐标，**保持原来的引用形式**。
 *
 * 这一点很重要：`{ at: "mid", offset: [0, 1.2] }` 表达的是「中间锥桶前方 1.2 米」，
 * 拖动后应该还是相对 mid 的偏移。如果塌成绝对坐标，作者「跟着锥桶走」的意图就丢了——
 * 以后挪动锥桶，球员不会跟着动。
 *
 * `{ toward, stopShort }` 的终点是运行时算出来的，没法用一个坐标表达，所以不允许拖。
 */
export function retargetPosition(
  ref: PositionRef,
  target: Vec2,
  drill: Drill,
): RetargetResult {
  if (isAbsolutePos(ref)) {
    return { ok: true, ref: [round(target[0]), round(target[1])] }
  }

  if (isRelativePos(ref)) {
    const base = staticPosOf(drill, ref.at)
    if (base === undefined) {
      // 相对的是一个没有固定位置的球员，基准点随时间变，拖不了
      return { ok: false, reason: 'unknown-base' }
    }
    return {
      ok: true,
      ref: { at: ref.at, offset: [round(target[0] - base[0]), round(target[1] - base[1])] },
    }
  }

  if (isTowardPos(ref)) {
    return { ok: false, reason: 'toward' }
  }

  return { ok: true, ref: [round(target[0]), round(target[1])] }
}

/** 位置保留一位小数：再细的精度对 20 米的场地没意义，还会让 JSON 变脏。 */
export function round(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 把坐标夹在场地内并取整到一位小数。
 *
 * 只夹被拖的那个对象自己。相对它定位的动作终点（`{at, offset}`）可能因此越界——
 * 那种情况交给实时校验提示并阻止保存，而不是在这里连带夹紧依赖项：
 * 那会让「我明明拖到这里，它却跑到别处」，比报错更难理解。
 */
export function clampToField(pos: Vec2, drill: Drill): Vec2 {
  return [
    round(Math.min(Math.max(pos[0], 0), drill.field.width)),
    round(Math.min(Math.max(pos[1], 0), drill.field.height)),
  ]
}

export const NOT_DRAGGABLE_LABEL: Record<NotDraggableReason, string> = {
  toward: '这一步写的是「朝目标跑、在几米处停下」，终点由运行时算出，不能直接拖。可在属性面板里改停止距离。',
  'unknown-base': '这个位置是相对一个会移动的球员定的，基准点随时间变化，不能直接拖。',
}
