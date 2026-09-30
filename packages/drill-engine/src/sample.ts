import type { Actor, DrillObject, Vec2 } from '@drill/schema'
import {
  BALL_DISTANCE,
  ballOffsetFrom,
  type ActorMotion,
  type Segment,
  type Timeline,
} from './compile.js'
import {
  clamp01,
  easeInOut,
  easeRamp,
  lerpVec,
  normalizeDeg,
  polylinePoint,
  polylineUpTo,
} from './math.js'
import type { TurnDirection } from './turn.js'

export interface ActorFrame {
  id: string
  pos: Vec2
  /** 朝向（度），0° 指向 +x，顺时针为正。 */
  facing: number
  moving: boolean
  role: Actor['role']
  label?: string
  team?: Actor['team']
}

export interface BallFrame {
  id: string
  pos: Vec2
  ownerId?: string
}

/** 当前轮次已跑过的路线，用来画虚线。 */
export interface TrailFrame {
  actorId: string
  points: Vec2[]
  /** 这一段是带球还是无球跑动。渲染层据此决定画波浪线还是直虚线。 */
  withBall: boolean
}

/** 慢放阶段的转身高亮。 */
export interface TurnHighlightFrame {
  actorId: string
  center: Vec2
  radius: number
  fromFacing: number
  /** 当前已经转到的朝向。 */
  currentFacing: number
  direction: TurnDirection
}

export interface FrameState {
  time: number
  duration: number
  roundIndex: number
  roundTotal: number
  phaseIndex: number
  slowMotion: boolean
  /** 顶部实时显示的说明。 */
  narration: string
  field: Timeline['field']
  objects: DrillObject[]
  actors: ActorFrame[]
  balls: BallFrame[]
  trails: TrailFrame[]
  turnHighlight?: TurnHighlightFrame
}

/**
 * 时间线采样：纯函数，给定 t（秒）返回该时刻所有对象的位置与朝向。
 * 前端播放和服务端逐帧导出都调这一个函数，保证两边画面完全一致。
 */
export function sampleTimeline(timeline: Timeline, time: number): FrameState {
  const clamped = Math.min(Math.max(time, 0), timeline.duration)
  const index = findSegmentIndex(timeline.segments, clamped)
  const segment = timeline.segments[index]

  if (segment === undefined) {
    // 没有任何阶段（校验已排除），退化成初始站位
    return emptyFrame(timeline, clamped)
  }

  const raw = segment.duration === 0 ? 1 : (clamped - segment.startTime) / segment.duration
  const progress = clamp01(raw)
  const eased = easeInOut(progress)

  const actorById = new Map(timeline.actors.map((a) => [a.id, a]))
  const facingById = new Map<string, number>()
  const posById = new Map<string, Vec2>()
  const actors: ActorFrame[] = []

  /** 每个球员的缓动进度：连续跑动的中间阶段是匀速的，和整段的 eased 不同。 */
  const easedByActor = new Map<string, number>()

  for (const motion of segment.actors) {
    const motionEased = easeRamp(progress, motion.easeIn, motion.easeOut)
    easedByActor.set(motion.actorId, motionEased)
    const pos = samplePos(motion, motionEased)
    const facing = sampleFacing(motion, motionEased)
    posById.set(motion.actorId, pos)
    facingById.set(motion.actorId, facing)

    const actor = actorById.get(motion.actorId)
    actors.push({
      id: motion.actorId,
      pos,
      facing,
      moving: motion.moving,
      role: actor?.role ?? 'neutral',
      ...(actor?.label === undefined ? {} : { label: actor.label }),
      ...(actor?.team === undefined ? {} : { team: actor.team }),
    })
  }

  const balls: BallFrame[] = segment.balls.map((ball) => {
    switch (ball.kind) {
      case 'withOwner': {
        const pos = posById.get(ball.ownerId)
        const facing = facingById.get(ball.ownerId) ?? 0
        return {
          id: ball.ballId,
          pos: pos === undefined ? [0, 0] : ballOffsetFrom(pos, facing),
          ownerId: ball.ownerId,
        }
      }
      case 'travel':
        return {
          id: ball.ballId,
          pos: lerpVec(ball.from, ball.to, eased),
          ...(progress >= 1 && ball.toOwnerId !== undefined ? { ownerId: ball.toOwnerId } : {}),
        }
      case 'static':
        return { id: ball.ballId, pos: ball.pos }
    }
  })

  const round = timeline.rounds[segment.roundIndex]

  return {
    time: clamped,
    duration: timeline.duration,
    roundIndex: segment.roundIndex,
    roundTotal: timeline.rounds.length,
    phaseIndex: segment.phaseIndex,
    slowMotion: segment.slowMotion,
    narration: round?.narration ?? '',
    field: timeline.field,
    objects: timeline.objects,
    actors,
    balls,
    trails: buildTrails(timeline, index, easedByActor),
    ...(buildTurnHighlight(segment, posById, facingById) ?? {}),
  }
}

function samplePos(motion: ActorMotion, eased: number): Vec2 {
  const first = motion.points[0]!
  if (motion.points.length === 1) return first
  return polylinePoint(motion.points, eased)
}

function sampleFacing(motion: ActorMotion, eased: number): number {
  if (motion.facingDelta === 0) return motion.facingFrom
  return normalizeDeg(motion.facingFrom + motion.facingDelta * eased)
}

/** 二分查找 t 落在哪个 segment；t 正好落在边界时归到后一段。 */
function findSegmentIndex(segments: readonly Segment[], time: number): number {
  if (segments.length === 0) return -1
  let low = 0
  let high = segments.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    const segment = segments[mid]!
    if (time < segment.endTime) {
      high = mid
    } else {
      low = mid + 1
    }
  }
  return low
}

/** 当前轮次内、到当前时刻为止各球员跑过的路线。 */
function buildTrails(
  timeline: Timeline,
  currentIndex: number,
  easedByActor: Map<string, number>,
): TrailFrame[] {
  const current = timeline.segments[currentIndex]
  if (current === undefined) return []

  /**
   * 一个球员可能有多段轨迹：带球和无球跑动的线形不同，不能画成一条。
   * 相邻阶段只要「同样带球/同样无球」且首尾相接，就合成一段——
   * 这样虚线的节奏是连续的，不会在每个阶段边界打一个结。
   */
  const byActor = new Map<string, TrailFrame[]>()

  for (let i = 0; i <= currentIndex; i++) {
    const segment = timeline.segments[i]!
    if (segment.roundIndex !== current.roundIndex) continue

    for (const motion of segment.actors) {
      if (!motion.moving) continue
      const partial =
        i === currentIndex
          ? polylineUpTo(motion.points, easedByActor.get(motion.actorId) ?? 1)
          : [...motion.points]
      if (partial.length === 0) continue

      const list = byActor.get(motion.actorId) ?? []
      const last = list.at(-1)
      const joins =
        last !== undefined &&
        last.withBall === motion.withBall &&
        samePoint(last.points.at(-1), partial[0])

      if (joins) {
        // 上一段的终点就是这一段的起点，去掉重复点
        last.points.push(...partial.slice(1))
      } else {
        list.push({ actorId: motion.actorId, points: partial, withBall: motion.withBall })
      }
      byActor.set(motion.actorId, list)
    }
  }

  return [...byActor.values()].flat()
}

function samePoint(a: Vec2 | undefined, b: Vec2 | undefined): boolean {
  if (a === undefined || b === undefined) return false
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
}

function buildTurnHighlight(
  segment: Segment,
  posById: Map<string, Vec2>,
  facingById: Map<string, number>,
): { turnHighlight: TurnHighlightFrame } | undefined {
  if (!segment.slowMotion) return undefined

  const turning = segment.actors.find((m) => m.turn !== undefined)
  if (turning === undefined) return undefined

  const center = posById.get(turning.actorId)
  if (center === undefined) return undefined

  return {
    turnHighlight: {
      actorId: turning.actorId,
      center,
      radius: BALL_DISTANCE,
      fromFacing: turning.facingFrom,
      currentFacing: facingById.get(turning.actorId) ?? turning.facingFrom,
      direction: turning.turn!.direction,
    },
  }
}

function emptyFrame(timeline: Timeline, time: number): FrameState {
  return {
    time,
    duration: timeline.duration,
    roundIndex: 0,
    roundTotal: timeline.rounds.length,
    phaseIndex: 0,
    slowMotion: false,
    narration: '',
    field: timeline.field,
    objects: timeline.objects,
    actors: timeline.actors.map((actor) => ({
      id: actor.id,
      pos: timeline.initialPositions[actor.id] ?? [0, 0],
      facing: timeline.initialFacing[actor.id] ?? 0,
      moving: false,
      role: actor.role,
      ...(actor.label === undefined ? {} : { label: actor.label }),
      ...(actor.team === undefined ? {} : { team: actor.team }),
    })),
    balls: [],
    trails: [],
  }
}
