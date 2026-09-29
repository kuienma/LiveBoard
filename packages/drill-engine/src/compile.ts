import { smoothRoute } from './smooth.js'
import {
  isAbsolutePos,
  isRelativePos,
  isTowardPos,
  type Action,
  type Actor,
  type Drill,
  type DrillField,
  type DrillMeta,
  type DrillObject,
  type PositionRef,
  type Variant,
  type Vec2,
} from '@drill/schema'
import {
  add,
  distance,
  normalize,
  normalizeDeg,
  polylineHeading,
  scale,
  sub,
} from './math.js'
import { solveTurn, type TurnDirection } from './turn.js'

/**
 * 球画在持球球员朝向前方这么远（米）。转身时球就沿这个半径绕过去。
 * 取值要大于球员圆点半径（0.5m），否则球会嵌在圆点里看不清绕行方向。
 */
export const BALL_DISTANCE = 0.62

/** 全程没有移动、也没写 facing 的球员的默认朝向：朝下（面向读者）。 */
export const DEFAULT_FACING = 90

export interface CompiledTurn {
  direction: TurnDirection
  awayFromId?: string
  /** 对手正好在正前方/正后方，方向由兜底规则决定。 */
  degenerate: boolean
}

export interface ActorMotion {
  actorId: string
  /** 移动路径，至少一个点；单点表示原地不动。 */
  points: Vec2[]
  facingFrom: number
  /** 带符号的朝向变化量：转身时即转身方向，移动时取最短弧。 */
  facingDelta: number
  moving: boolean
  /**
   * 是否在本段开头加速 / 结尾减速。
   * 连续跑动的中间阶段两者都是 false，球员才不会在阶段边界停一下。
   */
  easeIn: boolean
  easeOut: boolean
  turn?: CompiledTurn
}

export type BallMotion =
  | { ballId: string; kind: 'withOwner'; ownerId: string }
  | { ballId: string; kind: 'static'; pos: Vec2 }
  | { ballId: string; kind: 'travel'; from: Vec2; to: Vec2; toOwnerId?: string }

export interface Segment {
  roundIndex: number
  phaseIndex: number
  startTime: number
  endTime: number
  duration: number
  slowMotion: boolean
  note?: string
  actors: ActorMotion[]
  balls: BallMotion[]
}

export interface RoundInfo {
  /** 0 起算。 */
  index: number
  startTime: number
  duration: number
  /** 顶部实时显示的说明，如「第 2 次：防守者从左边来，运球员向右转身」。 */
  narration: string
  /** 该轮转身时对手在画面的哪一侧（没有转身动作则为 undefined）。 */
  opponentSide?: 'left' | 'right'
  /** 该轮转身朝画面的哪一侧（与 opponentSide 相反）。 */
  turnSide?: 'left' | 'right'
}

export interface Timeline {
  variantId: string
  variantName: string
  description?: string
  /** 总时长（秒）。 */
  duration: number
  rounds: RoundInfo[]
  segments: Segment[]
  /** 渲染需要的静态数据，原样带过来，避免渲染层再依赖整份 drill。 */
  meta: DrillMeta
  field: DrillField
  objects: DrillObject[]
  actors: Actor[]
  initialFacing: Record<string, number>
  initialPositions: Record<string, Vec2>
}

/**
 * 把一个练法编译成时间线。纯函数：同样的输入永远得到同样的输出，不读时钟、不改参数。
 *
 * 语义要点（见 docs/spec.md 第 3 节及与需求方确认的补充）：
 * - `setup` 只在练法开头应用一次，各轮从上一轮结束状态接续；
 * - `repeat.times` 是总轮数，`swap` 逐轮切换（奇数轮原始引用、偶数轮互换）；
 * - 同一阶段内的动作同时发生，因此都以该阶段开始时的状态为基准解析位置；
 * - `slowMotion` 不改变时长，只作为渲染提示。
 */
export function compileVariant(drill: Drill, variantId: string): Timeline {
  const variant = drill.variants.find((v) => v.id === variantId)
  if (variant === undefined) {
    throw new Error(`找不到练法「${variantId}」`)
  }

  const objectPos = new Map(drill.objects.map((o) => [o.id, o.pos]))
  const actorById = new Map(drill.actors.map((a) => [a.id, a]))
  const rounds = variant.repeat?.times ?? 1

  const initialPositions = resolveInitialPositions(drill, variant, objectPos)

  // 先只算位置，拿到每个球员第一次移动的方向，用来定初始朝向
  const firstHeadings = collectFirstHeadings(variant, objectPos, initialPositions, rounds)
  const initialFacing = new Map<string, number>()
  for (const actor of drill.actors) {
    initialFacing.set(
      actor.id,
      actor.facing ?? firstHeadings.get(actor.id) ?? DEFAULT_FACING,
    )
  }

  const positions = new Map(initialPositions)
  const facings = new Map(initialFacing)
  const ballOwner = new Map<string, string | null>()
  const ballPos = new Map<string, Vec2>()
  for (const ball of drill.balls) {
    ballOwner.set(ball.id, ball.owner ?? null)
    if (ball.pos !== undefined) ballPos.set(ball.id, ball.pos)
  }

  const segments: Segment[] = []
  const roundInfos: RoundInfo[] = []
  let time = 0

  for (let round = 0; round < rounds; round++) {
    const mapId = makeIdMapper(variant, round)
    const roundStart = time
    let opponentSide: 'left' | 'right' | undefined
    let turnerId: string | undefined
    let opponentId: string | undefined
    let turnerHoldsBall = false

    for (const [phaseIndex, phase] of variant.phases.entries()) {
      // 同一阶段内的动作同时发生：全部以阶段开始时的快照为基准
      const snapshot = new Map(positions)
      const lookup = (id: string): Vec2 | undefined =>
        objectPos.get(id) ?? snapshot.get(id)

      const actionByActor = new Map<string, Action>()
      for (const action of phase.actions) {
        actionByActor.set(action.actor, action)
      }

      const motions: ActorMotion[] = []
      const nextPositions = new Map<string, Vec2>()
      const nextFacings = new Map<string, number>()

      for (const actor of drill.actors) {
        const from = snapshot.get(actor.id)
        if (from === undefined) continue
        const facingFrom = facings.get(actor.id) ?? DEFAULT_FACING
        const action = actionByActor.get(actor.id)

        if (action === undefined || action.type === 'wait') {
          motions.push({
            actorId: actor.id,
            points: [from],
            facingFrom,
            facingDelta: 0,
            moving: false,
            easeIn: true,
            easeOut: true,
          })
          continue
        }

        if (action.type === 'turn') {
          const targetId = action.awayFrom === undefined ? undefined : mapId(action.awayFrom)
          const targetPos = targetId === undefined ? undefined : lookup(targetId)
          const solution = solveTurn(facingFrom, action.degrees, from, targetPos)

          motions.push({
            actorId: actor.id,
            points: [from],
            facingFrom,
            facingDelta: solution.delta,
            moving: false,
            easeIn: true,
            easeOut: true,
            turn: {
              direction: solution.direction,
              ...(targetId === undefined ? {} : { awayFromId: targetId }),
              degenerate: solution.degenerate,
            },
          })
          nextFacings.set(actor.id, solution.facingTo)

          // 记录该轮的方向信息，供顶部文字使用
          if (opponentSide === undefined && targetPos !== undefined) {
            opponentSide = targetPos[0] >= from[0] ? 'right' : 'left'
            turnerId = actor.id
            opponentId = targetId
            turnerHoldsBall = ballHeldBy(ballOwner, actor.id) !== undefined
          }
          continue
        }

        if (action.type === 'run' || action.type === 'dribble') {
          const points = resolveMovePath(action, from, mapId, lookup)
          const headingTo = polylineHeading(points, 1)
          const facingDelta =
            headingTo === undefined ? 0 : normalizeDeg(headingTo - facingFrom)
          const last = points[points.length - 1]!
          motions.push({
            actorId: actor.id,
            points,
            facingFrom,
            facingDelta,
            moving: distance(from, last) > 0,
            // 默认两端缓动；连续跑动的中间阶段由 smoothSegments 改成匀速
            easeIn: true,
            easeOut: true,
          })
          nextPositions.set(actor.id, last)
          // 跑动结束时球员面朝前进方向，必须写回，否则下一轮的转身会用到上一轮的旧朝向
          nextFacings.set(actor.id, normalizeDeg(facingFrom + facingDelta))
          continue
        }

        // pass / shoot：球员原地不动，只是球出去了
        motions.push({
          actorId: actor.id,
          points: [from],
          facingFrom,
          facingDelta: 0,
          moving: false,
          easeIn: true,
          easeOut: true,
        })
      }

      const balls = resolveBallMotions(
        drill,
        phase.actions,
        ballOwner,
        ballPos,
        snapshot,
        nextPositions,
        facings,
        nextFacings,
        mapId,
        lookup,
      )

      segments.push({
        roundIndex: round,
        phaseIndex,
        startTime: time,
        endTime: time + phase.duration,
        duration: phase.duration,
        slowMotion: phase.slowMotion,
        ...(phase.note === undefined ? {} : { note: phase.note }),
        actors: motions,
        balls,
      })

      time += phase.duration
      for (const [id, pos] of nextPositions) positions.set(id, pos)
      for (const [id, facing] of nextFacings) facings.set(id, facing)
    }

    roundInfos.push({
      index: round,
      startTime: roundStart,
      duration: time - roundStart,
      narration: buildNarration({
        round,
        rounds,
        variant,
        opponentSide,
        turnerId,
        opponentId,
        actorById,
        holdsBall: turnerHoldsBall,
      }),
      ...(opponentSide === undefined
        ? {}
        : {
            opponentSide,
            turnSide: opponentSide === 'right' ? ('left' as const) : ('right' as const),
          }),
    })
  }

  smoothSegments(segments)

  return {
    variantId: variant.id,
    variantName: variant.name,
    ...(variant.description === undefined ? {} : { description: variant.description }),
    duration: time,
    rounds: roundInfos,
    segments,
    meta: drill.meta,
    field: drill.field,
    objects: drill.objects,
    actors: drill.actors,
    initialFacing: Object.fromEntries(initialFacing),
    initialPositions: Object.fromEntries(initialPositions),
  }
}

/** 编译所有练法。 */
export function compileDrill(drill: Drill): Timeline[] {
  return drill.variants.map((v) => compileVariant(drill, v.id))
}

/**
 * 造出该轮的 id 重映射函数。
 *
 * swap 与 rotate 走同一条路径：swap: [a, b] 就是 rotate: [a, b]，
 * 每轮把引用在环里后移一位——两元素时后移一位正好等于互换。
 */
function makeIdMapper(variant: Variant, round: number): (id: string) => string {
  const cycle =
    variant.repeat?.rotate ??
    (variant.repeat?.swap === undefined ? undefined : [...variant.repeat.swap])
  if (cycle === undefined || cycle.length < 2) return (id) => id

  const shift = round % cycle.length
  if (shift === 0) return (id) => id

  const indexOf = new Map(cycle.map((id, index) => [id, index]))
  return (id) => {
    const index = indexOf.get(id)
    return index === undefined ? id : cycle[(index + shift) % cycle.length]!
  }
}

function resolveInitialPositions(
  drill: Drill,
  variant: Variant,
  objectPos: Map<string, Vec2>,
): Map<string, Vec2> {
  const positions = new Map<string, Vec2>()

  // 先放固定站位的球员，后面 setup 里的引用可能指向他们
  for (const actor of drill.actors) {
    if (actor.pos !== undefined) positions.set(actor.id, actor.pos)
  }

  const mapId = makeIdMapper(variant, 0)
  const lookup = (id: string): Vec2 | undefined => objectPos.get(id) ?? positions.get(id)

  for (const actor of drill.actors) {
    const ref = variant.setup[actor.id]
    if (ref === undefined) continue
    positions.set(actor.id, resolveRef(ref, undefined, mapId, lookup))
  }

  return positions
}

/** 只走一遍位置，记录每个球员第一次真正移动的方向（度）。 */
function collectFirstHeadings(
  variant: Variant,
  objectPos: Map<string, Vec2>,
  initialPositions: Map<string, Vec2>,
  rounds: number,
): Map<string, number> {
  const headings = new Map<string, number>()
  const positions = new Map(initialPositions)

  for (let round = 0; round < rounds; round++) {
    const mapId = makeIdMapper(variant, round)
    for (const phase of variant.phases) {
      const snapshot = new Map(positions)
      const lookup = (id: string): Vec2 | undefined => objectPos.get(id) ?? snapshot.get(id)
      for (const action of phase.actions) {
        if (action.type !== 'run' && action.type !== 'dribble') continue
        const from = snapshot.get(action.actor)
        if (from === undefined) continue
        const points = resolveMovePath(action, from, mapId, lookup)
        const heading = polylineHeading(points, 0)
        if (heading !== undefined && !headings.has(action.actor)) {
          headings.set(action.actor, heading)
        }
        positions.set(action.actor, points[points.length - 1]!)
      }
    }
  }

  return headings
}

function resolveMovePath(
  action: Extract<Action, { type: 'run' | 'dribble' }>,
  from: Vec2,
  mapId: (id: string) => string,
  lookup: (id: string) => Vec2 | undefined,
): Vec2[] {
  const points: Vec2[] = [from]
  for (const via of action.via ?? []) {
    points.push(resolveRef(via, points[points.length - 1]!, mapId, lookup))
  }
  points.push(resolveRef(action.to, points[points.length - 1]!, mapId, lookup))
  return points
}

/**
 * 解析位置引用。
 * `toward` + `stopShort` 需要出发点，所以 from 必须传；解析发生在阶段开始时，
 * 目标位置取该时刻的快照，整个阶段内不再变化，保证路径是确定的直线。
 */
export function resolveRef(
  ref: PositionRef,
  from: Vec2 | undefined,
  mapId: (id: string) => string,
  lookup: (id: string) => Vec2 | undefined,
): Vec2 {
  if (isAbsolutePos(ref)) return [ref[0], ref[1]]

  if (isRelativePos(ref)) {
    const base = lookup(mapId(ref.at))
    if (base === undefined) {
      throw new Error(`位置引用的 id「${ref.at}」找不到，应在校验阶段拦下`)
    }
    return ref.offset === undefined ? [base[0], base[1]] : add(base, ref.offset)
  }

  if (isTowardPos(ref)) {
    const target = lookup(mapId(ref.toward))
    if (target === undefined) {
      throw new Error(`位置引用的 id「${ref.toward}」找不到，应在校验阶段拦下`)
    }
    if (from === undefined) return [target[0], target[1]]
    const gap = sub(target, from)
    const total = distance(from, target)
    const travel = Math.max(0, total - ref.stopShort)
    return add(from, scale(normalize(gap), travel))
  }

  throw new Error('无法识别的位置写法，应在校验阶段拦下')
}

function ballHeldBy(
  ballOwner: Map<string, string | null>,
  actorId: string,
): string | undefined {
  for (const [ballId, owner] of ballOwner) {
    if (owner === actorId) return ballId
  }
  return undefined
}

function resolveBallMotions(
  drill: Drill,
  actions: readonly Action[],
  ballOwner: Map<string, string | null>,
  ballPos: Map<string, Vec2>,
  snapshot: Map<string, Vec2>,
  nextPositions: Map<string, Vec2>,
  facings: Map<string, number>,
  nextFacings: Map<string, number>,
  mapId: (id: string) => string,
  lookup: (id: string) => Vec2 | undefined,
): BallMotion[] {
  const motions: BallMotion[] = []

  for (const ball of drill.balls) {
    const owner = ballOwner.get(ball.id) ?? null

    const passOrShoot = actions.find(
      (a): a is Extract<Action, { type: 'pass' | 'shoot' }> =>
        a.actor === owner && (a.type === 'pass' || a.type === 'shoot'),
    )
    // run 是无球跑动：持球者选择 run 时球留在原地，归属释放
    const abandon = actions.find((a) => a.actor === owner && a.type === 'run')

    if (owner !== null && passOrShoot !== undefined) {
      const from = footOf(owner, snapshot, facings, nextFacings)
      const to =
        passOrShoot.type === 'pass'
          ? footOf(passOrShoot.to, nextPositions.size > 0 ? mergePos(snapshot, nextPositions) : snapshot, facings, nextFacings)
          : resolveRef(passOrShoot.to, from, mapId, lookup)

      motions.push({
        ballId: ball.id,
        kind: 'travel',
        from,
        to,
        ...(passOrShoot.type === 'pass' ? { toOwnerId: passOrShoot.to } : {}),
      })
      ballOwner.set(ball.id, passOrShoot.type === 'pass' ? passOrShoot.to : null)
      ballPos.set(ball.id, to)
      continue
    }

    if (owner !== null && abandon !== undefined) {
      const stay = footOf(owner, snapshot, facings, nextFacings)
      motions.push({ ballId: ball.id, kind: 'static', pos: stay })
      ballOwner.set(ball.id, null)
      ballPos.set(ball.id, stay)
      continue
    }

    if (owner !== null) {
      motions.push({ ballId: ball.id, kind: 'withOwner', ownerId: owner })
      continue
    }

    const pos = ballPos.get(ball.id) ?? [0, 0]
    motions.push({ ballId: ball.id, kind: 'static', pos })
  }

  return motions
}

function mergePos(base: Map<string, Vec2>, overrides: Map<string, Vec2>): Map<string, Vec2> {
  const merged = new Map(base)
  for (const [id, pos] of overrides) merged.set(id, pos)
  return merged
}

/** 球在持球球员脚前的位置：球员位置沿朝向前移 BALL_DISTANCE。 */
export function footOf(
  actorId: string,
  positions: Map<string, Vec2>,
  facings: Map<string, number>,
  overrideFacings?: Map<string, number>,
): Vec2 {
  const pos = positions.get(actorId)
  if (pos === undefined) return [0, 0]
  const facing = overrideFacings?.get(actorId) ?? facings.get(actorId) ?? DEFAULT_FACING
  return ballOffsetFrom(pos, facing)
}

/** 给定球员位置和朝向，算出球该画在哪。渲染与采样共用。 */
export function ballOffsetFrom(pos: Vec2, facing: number): Vec2 {
  const rad = (facing * Math.PI) / 180
  return [pos[0] + Math.cos(rad) * BALL_DISTANCE, pos[1] + Math.sin(rad) * BALL_DISTANCE]
}

function buildNarration(input: {
  round: number
  rounds: number
  variant: Variant
  opponentSide?: 'left' | 'right'
  turnerId?: string
  opponentId?: string
  actorById: Map<string, Actor>
  holdsBall: boolean
}): string {
  const { round, rounds, variant, opponentSide, turnerId, opponentId, actorById, holdsBall } = input

  const prefix = rounds > 1 ? `第 ${round + 1} 次` : ''

  if (opponentSide === undefined || turnerId === undefined) {
    return prefix === '' ? (variant.description ?? '') : prefix
  }

  const opponent = opponentId === undefined ? undefined : actorById.get(opponentId)
  const opponentName =
    opponent === undefined
      ? (opponentId ?? '对手')
      : opponent.role === 'defender'
        ? '防守者'
        : (opponent.label ?? opponent.id)

  const turner = actorById.get(turnerId)
  const turnerName = holdsBall ? '运球员' : (turner?.label ?? turnerId)

  const fromSide = opponentSide === 'left' ? '左' : '右'
  const toSide = opponentSide === 'left' ? '右' : '左'
  const body = `${opponentName}从${fromSide}边来，${turnerName}向${toSide}转身`

  return prefix === '' ? body : `${prefix}：${body}`
}

/**
 * 把折角磨圆。
 *
 * 逐阶段编译出来的路径是一段段直线，相邻阶段衔接处、以及一个动作内的 via 点处
 * 都是硬折角，看起来像锯齿。这里按「同一轮里连续移动的若干阶段」为一条路线整体
 * 平滑，再按原路点切回每个阶段——切点正是原来的路点，所以每个阶段的起终点不变，
 * 阶段时长、球的归属、转身判定全都不受影响。
 *
 * 路线在这些地方断开：换轮、中间夹了不移动的阶段（转身/原地不动）、
 * 以及该球员这一阶段没有动作。断开处保留尖角是对的——真人也是先停下再掉头。
 */
function smoothSegments(segments: Segment[]): void {
  const actorIds = new Set<string>()
  for (const segment of segments) for (const motion of segment.actors) actorIds.add(motion.actorId)

  for (const actorId of actorIds) {
    /** 一条连续路线：记下它由哪些 (segment, motion) 组成。 */
    let run: Array<{ motion: ActorMotion }> = []

    const flush = () => {
      const motions = run.map((item) => item.motion)
      applySmoothing(motions)
      // 只在整段连续跑动的头尾缓动
      for (const [index, motion] of motions.entries()) {
        motion.easeIn = index === 0
        motion.easeOut = index === motions.length - 1
      }
      run = []
    }

    let lastRound = -1
    for (const segment of segments) {
      if (segment.roundIndex !== lastRound) {
        flush()
        lastRound = segment.roundIndex
      }
      const motion = segment.actors.find((item) => item.actorId === actorId)
      if (motion === undefined || !motion.moving || motion.points.length < 2) {
        flush()
        continue
      }
      run.push({ motion })
    }
    flush()
  }
}

/** 把若干连续阶段的路点接成一条，平滑后切回各阶段。 */
function applySmoothing(motions: ActorMotion[]): void {
  // 接成一条路点序列：相邻阶段的「上一段终点 == 下一段起点」只保留一次
  const waypoints: Vec2[] = []
  /** 每个阶段在 waypoints 里占的区间 [起点下标, 终点下标]。 */
  const ranges: Array<[number, number]> = []

  for (const motion of motions) {
    const start = waypoints.length === 0 ? 0 : waypoints.length - 1
    for (const [index, point] of motion.points.entries()) {
      if (index === 0 && waypoints.length > 0) continue
      waypoints.push(point)
    }
    ranges.push([start, waypoints.length - 1])
  }

  if (waypoints.length < 3) return

  const { points, waypointIndexes } = smoothRoute(waypoints)
  for (const [index, motion] of motions.entries()) {
    const [from, to] = ranges[index]!
    const sliced = points.slice(waypointIndexes[from]!, waypointIndexes[to]! + 1)
    // 至少要两个点才算移动；理论上不会发生，兜一下免得把静止阶段搞出来
    if (sliced.length >= 2) motion.points = sliced
  }
}
