import {
  isAbsolutePos,
  isRelativePos,
  isTowardPos,
  type Actor,
  type Drill,
  type PositionRef,
  type Vec2,
} from './schema.js'

/** 一条可读的校验错误。path 指向出错的字段，便于把错误列表发回模型重试。 */
export interface DrillIssue {
  path: string
  message: string
}

/**
 * 业务规则校验（Schema 通过之后才跑）。规则来自 docs/spec.md 第 4.1 节：
 * 引用的 id 都存在、坐标在场内、每个 variant 至少一个阶段、dribble 的球员此时确实持球。
 */
export function checkRules(drill: Drill): DrillIssue[] {
  const issues: DrillIssue[] = []

  const objectById = new Map(drill.objects.map((o) => [o.id, o]))
  const actorById = new Map(drill.actors.map((a) => [a.id, a]))

  checkUniqueIds(drill, issues)

  // 球的初始状态
  for (const [index, ball] of drill.balls.entries()) {
    const path = `balls[${index}]`
    if (ball.owner === undefined && ball.pos === undefined) {
      issues.push({ path, message: '球必须指定 owner（归属球员）或 pos（放置位置）' })
    }
    if (ball.owner !== undefined && !actorById.has(ball.owner)) {
      issues.push({ path: `${path}.owner`, message: `引用了不存在的球员 id「${ball.owner}」` })
    }
    if (ball.pos !== undefined) {
      checkInsideField(ball.pos, drill, `${path}.pos`, issues)
    }
  }

  // 固定站位的对象与球员
  for (const [index, object] of drill.objects.entries()) {
    checkInsideField(object.pos, drill, `objects[${index}].pos`, issues)
  }
  for (const [index, actor] of drill.actors.entries()) {
    if (actor.pos !== undefined) {
      checkInsideField(actor.pos, drill, `actors[${index}].pos`, issues)
    }
  }

  // 一个动作都没有的数据渲染不出任何动画。模型识别失败时容易编出这种占位结构，
  // 看起来字段齐全却毫无内容，必须在这里拦掉。
  const totalActions = drill.variants.reduce(
    (sum, variant) => sum + variant.phases.reduce((n, phase) => n + phase.actions.length, 0),
    0,
  )
  if (totalActions === 0) {
    issues.push({
      path: 'variants',
      message: '所有练法里都没有任何动作，这份数据生成不出动画',
    })
  }

  const variantIds = new Set<string>()
  for (const [vIndex, variant] of drill.variants.entries()) {
    const vPath = `variants[${vIndex}]`
    if (variantIds.has(variant.id)) {
      issues.push({ path: `${vPath}.id`, message: `练法 id「${variant.id}」重复` })
    }
    variantIds.add(variant.id)

    const isKnownId = (id: string) => objectById.has(id) || actorById.has(id)

    // setup
    for (const [actorId, ref] of Object.entries(variant.setup)) {
      const path = `${vPath}.setup.${actorId}`
      if (!actorById.has(actorId)) {
        issues.push({ path, message: `引用了不存在的球员 id「${actorId}」` })
      }
      checkPositionRef(ref, drill, isKnownId, path, issues)
    }

    // 每个参与动作的球员都要有初始位置：setup 里给了，或 actors[].pos 固定
    const movers = new Set<string>()
    for (const phase of variant.phases) {
      for (const action of phase.actions) movers.add(action.actor)
    }
    for (const actorId of movers) {
      const actor = actorById.get(actorId)
      if (actor === undefined) continue // 下面的 action.actor 检查会报
      const hasSetup = Object.prototype.hasOwnProperty.call(variant.setup, actorId)
      if (!hasSetup && actor.pos === undefined) {
        issues.push({
          path: `${vPath}.setup`,
          message: `球员「${actorId}」参与了动作但没有初始位置，请在 setup 中指定或给 actors[].pos`,
        })
      }
    }

    // repeat.swap / repeat.rotate：两者都是「逐轮重映射 id」，校验规则相同
    const cycle =
      variant.repeat?.rotate ??
      (variant.repeat?.swap === undefined ? undefined : [...variant.repeat.swap])
    if (cycle !== undefined) {
      const field = variant.repeat?.rotate === undefined ? 'swap' : 'rotate'
      const path = `${vPath}.repeat.${field}`
      const seen = new Set<string>()
      for (const id of cycle) {
        if (seen.has(id)) {
          issues.push({ path, message: `${field} 里的 id「${id}」重复了，每个只能出现一次` })
        }
        seen.add(id)
        if (!isKnownId(id)) {
          issues.push({ path, message: `引用了不存在的 id「${id}」` })
        }
      }
    }

    checkPhases(drill, vIndex, isKnownId, actorById, issues)
  }

  return issues
}

function checkUniqueIds(drill: Drill, issues: DrillIssue[]): void {
  // 位置引用 `{at}`、`awayFrom`、`swap` 都按 id 在同一命名空间里查找，所以要全局唯一
  const seen = new Map<string, string>()
  const record = (id: string, path: string) => {
    const previous = seen.get(id)
    if (previous !== undefined) {
      issues.push({ path, message: `id「${id}」与 ${previous} 重复，所有 id 必须全局唯一` })
      return
    }
    seen.set(id, path)
  }
  drill.objects.forEach((o, i) => record(o.id, `objects[${i}]`))
  drill.actors.forEach((a, i) => record(a.id, `actors[${i}]`))
  drill.balls.forEach((b, i) => record(b.id, `balls[${i}]`))
}

function checkPhases(
  drill: Drill,
  vIndex: number,
  isKnownId: (id: string) => boolean,
  actorById: Map<string, Actor>,
  issues: DrillIssue[],
): void {
  const variant = drill.variants[vIndex]
  if (variant === undefined) return
  const vPath = `variants[${vIndex}]`

  // 球的归属随阶段推进而变化，用来验证 dribble/pass/shoot 时确实持球。
  // swap 只换位置引用，不影响归属，所以逐轮模拟即可。
  const ownerOf = new Map<string, string | null>()
  for (const ball of drill.balls) {
    ownerOf.set(ball.id, ball.owner ?? null)
  }
  const ballHeldBy = (actorId: string): string | undefined => {
    for (const [ballId, owner] of ownerOf) {
      if (owner === actorId) return ballId
    }
    return undefined
  }

  const rounds = variant.repeat?.times ?? 1
  for (let round = 0; round < rounds; round++) {
    for (const [pIndex, phase] of variant.phases.entries()) {
      // 轮次只影响持球检查的上下文，报错路径统一指向第一轮的位置，避免重复刷屏
      const pPath = `${vPath}.phases[${pIndex}]`
      const reportRound = round === 0

      const actorsThisPhase = new Set<string>()
      for (const [aIndex, action] of phase.actions.entries()) {
        const aPath = `${pPath}.actions[${aIndex}]`

        if (!actorById.has(action.actor)) {
          if (reportRound) {
            issues.push({
              path: `${aPath}.actor`,
              message: `引用了不存在的球员 id「${action.actor}」`,
            })
          }
          continue
        }
        if (actorsThisPhase.has(action.actor)) {
          if (reportRound) {
            issues.push({
              path: aPath,
              message: `球员「${action.actor}」在同一阶段里有多个动作，同一阶段内的动作是同时发生的`,
            })
          }
        }
        actorsThisPhase.add(action.actor)

        switch (action.type) {
          case 'run':
          case 'dribble': {
            if (reportRound) {
              checkPositionRef(action.to, drill, isKnownId, `${aPath}.to`, issues)
              action.via?.forEach((ref, i) =>
                checkPositionRef(ref, drill, isKnownId, `${aPath}.via[${i}]`, issues),
              )
            }
            if (action.type === 'dribble') {
              const ball = ballHeldBy(action.actor)
              if (ball === undefined) {
                issues.push({
                  path: aPath,
                  message:
                    rounds > 1
                      ? `第 ${round + 1} 轮时球员「${action.actor}」并未持球，不能 dribble`
                      : `球员「${action.actor}」此时并未持球，不能 dribble`,
                })
              }
            } else {
              // run 是无球跑动：若此前持球，球留在原地，归属释放
              const ball = ballHeldBy(action.actor)
              if (ball !== undefined) ownerOf.set(ball, null)
            }
            break
          }
          case 'turn': {
            if (reportRound && action.awayFrom !== undefined && !isKnownId(action.awayFrom)) {
              issues.push({
                path: `${aPath}.awayFrom`,
                message: `引用了不存在的 id「${action.awayFrom}」`,
              })
            }
            break
          }
          case 'pass': {
            const ball = ballHeldBy(action.actor)
            if (ball === undefined) {
              issues.push({
                path: aPath,
                message: `球员「${action.actor}」此时并未持球，不能 pass`,
              })
            }
            if (!actorById.has(action.to)) {
              if (reportRound) {
                issues.push({
                  path: `${aPath}.to`,
                  message: `传球目标「${action.to}」不是已存在的球员 id`,
                })
              }
            } else if (ball !== undefined) {
              ownerOf.set(ball, action.to)
            }
            break
          }
          case 'shoot': {
            const ball = ballHeldBy(action.actor)
            if (ball === undefined) {
              issues.push({
                path: aPath,
                message: `球员「${action.actor}」此时并未持球，不能 shoot`,
              })
            } else {
              ownerOf.set(ball, null)
            }
            if (reportRound) {
              checkPositionRef(action.to, drill, isKnownId, `${aPath}.to`, issues)
            }
            break
          }
          case 'wait':
            break
        }
      }
    }
  }
}

function checkPositionRef(
  ref: PositionRef,
  drill: Drill,
  isKnownId: (id: string) => boolean,
  path: string,
  issues: DrillIssue[],
): void {
  if (isAbsolutePos(ref)) {
    checkInsideField(ref, drill, path, issues)
    return
  }
  if (isRelativePos(ref)) {
    if (!isKnownId(ref.at)) {
      issues.push({ path: `${path}.at`, message: `引用了不存在的 id「${ref.at}」` })
      return
    }
    const resolved = resolveStatic(ref, drill)
    if (resolved !== undefined) {
      checkInsideField(resolved, drill, path, issues)
    }
    return
  }
  if (isTowardPos(ref)) {
    if (!isKnownId(ref.toward)) {
      issues.push({ path: `${path}.toward`, message: `引用了不存在的 id「${ref.toward}」` })
    }
    // 终点取决于运行时的出发位置，交给引擎在运行时保证
  }
}

/** 只解析静态可知的位置（绝对坐标，或相对有固定 pos 的对象/球员），其余返回 undefined 跳过越界检查。 */
function resolveStatic(ref: PositionRef, drill: Drill): Vec2 | undefined {
  if (isAbsolutePos(ref)) return ref
  if (!isRelativePos(ref)) return undefined

  const base =
    drill.objects.find((o) => o.id === ref.at)?.pos ??
    drill.actors.find((a) => a.id === ref.at)?.pos
  if (base === undefined) return undefined

  const offset = ref.offset ?? [0, 0]
  return [base[0] + offset[0], base[1] + offset[1]]
}

function checkInsideField(pos: Vec2, drill: Drill, path: string, issues: DrillIssue[]): void {
  const [x, y] = pos
  const { width, height } = drill.field
  if (x < 0 || x > width || y < 0 || y > height) {
    issues.push({
      path,
      message: `坐标 [${x}, ${y}] 超出场地范围（0..${width} × 0..${height}）`,
    })
  }
}
