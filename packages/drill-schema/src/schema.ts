import { z } from 'zod'

/**
 * Drill JSON 的结构定义（见 docs/spec.md 第 3 节）。
 *
 * 坐标约定：场地以米为单位，原点在左上角，x 向右、y 向下，与书上图的视角一致。
 * 角度约定：度数，0° 指向 +x（画面右），顺时针为正（因 y 轴向下）。
 */

/** 所有 id 共享同一命名空间：位置引用 `{at}` / `awayFrom` / `swap` 都按 id 查找，因此必须全局唯一。 */
export const idSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, { message: 'id 只能包含字母、数字、下划线和连字符' })

/** 场地坐标 [x, y]，单位米。 */
export const vec2Schema = z.tuple([z.number(), z.number()])

export const colorSchema = z.enum([
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'white',
  'black',
])

/**
 * 位置的三种写法：
 * - `[x, y]`：绝对坐标
 * - `{ at, offset }`：相对某个对象/球员的位置加偏移，方便引用锥桶而不必算坐标
 * - `{ toward, stopShort }`：朝目标跑，在距目标指定米数处停下（左右对称动作不用手写正负偏移）
 */
export const positionRefSchema = z.union([
  vec2Schema,
  z.strictObject({
    at: idSchema,
    offset: vec2Schema.optional(),
  }),
  z.strictObject({
    toward: idSchema,
    stopShort: z.number().min(0),
  }),
])

export const metaSchema = z.strictObject({
  title: z.string().min(1),
  /** 出处，如「第3章 运球」。 */
  source: z.string().optional(),
  category: z.enum([
    'dribbling',
    'passing',
    'shooting',
    'defending',
    'goalkeeping',
    'fitness',
    'warmup',
    'smallSidedGame',
    'other',
  ]),
  /** 教学要点，逐条中文。 */
  coachingPoints: z.array(z.string()).default([]),
})

export const fieldSchema = z.strictObject({
  width: z.number().positive(),
  height: z.number().positive(),
  style: z.enum(['grass', 'board']).default('grass'),
  /** 是否画边线。 */
  boundary: z.boolean().default(true),
})

/** 静态器材。 */
export const objectSchema = z.strictObject({
  id: idSchema,
  type: z.enum(['cone', 'disc', 'goal', 'pole']),
  color: colorSchema.default('orange'),
  size: z.enum(['tall', 'short']).default('short'),
  pos: vec2Schema,
})

export const actorSchema = z.strictObject({
  id: idSchema,
  role: z.enum(['attacker', 'defender', 'neutral', 'coach']),
  /** 画在圆点上的短标签，如「A」。 */
  label: z.string().max(3).optional(),
  team: colorSchema.optional(),
  /** 固定站位（如教练）。参与练法的球员在 `variants[].setup` 里给初始位置。 */
  pos: vec2Schema.optional(),
  /** 初始朝向（度）。缺省时由第一次移动方向推断，全程未移动则朝下（90°）。 */
  facing: z.number().optional(),
})

export const ballSchema = z.strictObject({
  id: idSchema,
  /** 初始归属的球员 id。与 pos 二选一。 */
  owner: idSchema.optional(),
  pos: vec2Schema.optional(),
})

const movementFields = {
  actor: idSchema,
  to: positionRefSchema,
  /** 途经点，用于生成弧线；缺省走直线。 */
  via: z.array(positionRefSchema).optional(),
}

export const actionSchema = z.discriminatedUnion('type', [
  /** 无球跑动。 */
  z.strictObject({ type: z.literal('run'), ...movementFields }),
  /** 带球跑，球跟随球员。 */
  z.strictObject({ type: z.literal('dribble'), ...movementFields }),
  /** 原地转身。degrees 取绝对值作为转过的角度，方向由 awayFrom 决定（球从远离该对象的一侧绕过）；
   *  没有 awayFrom 时按 degrees 的正负决定（正=顺时针）。 */
  z.strictObject({
    type: z.literal('turn'),
    actor: idSchema,
    degrees: z.number(),
    awayFrom: idSchema.optional(),
  }),
  /** 传球，球移到接球人。to 是接球人的 id。 */
  z.strictObject({ type: z.literal('pass'), actor: idSchema, to: idSchema }),
  /** 射门，球移到目标位置。 */
  z.strictObject({ type: z.literal('shoot'), actor: idSchema, to: positionRefSchema }),
  /** 原地不动。 */
  z.strictObject({ type: z.literal('wait'), actor: idSchema }),
])

/** 一个阶段内的所有动作同时发生。 */
export const phaseSchema = z.strictObject({
  duration: z.number().positive(),
  /** 该段本身就是慢动作：渲染时高亮转身方向。不改变时间轴长度。 */
  slowMotion: z.boolean().default(false),
  note: z.string().optional(),
  actions: z.array(actionSchema).default([]),
})

export const variantSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  /** 各球员的初始站位。只在该练法开头应用一次，后续各轮从上一轮结束状态接续。 */
  setup: z.record(idSchema, positionRefSchema).default({}),
  phases: z.array(phaseSchema).min(1, { message: '每个练法至少要有一个阶段' }),
  repeat: z
    .strictObject({
      /** 总轮数（不是「额外重复次数」）。 */
      times: z.number().int().min(1),
      /** 每轮结束后互换这两个 id 的引用，用于左右交替。等价于两元素的 rotate。 */
      swap: z.tuple([idSchema, idSchema]).optional(),
      /**
       * 每轮把这些 id 的引用循环后移一位，用于多人轮换。
       * 例如 rotate: ["c1","c2","c3","c4"]，第 2 轮里写 c1 的地方解析到 c2、写 c2 的解析到 c3……
       * 注意它只重映射 id，不会旋转 offset，所以轮换类动作里的位置建议不带 offset。
       */
      rotate: z.array(idSchema).min(2).optional(),
    })
    .refine((repeat) => repeat.swap === undefined || repeat.rotate === undefined, {
      message: 'swap 和 rotate 不能同时出现（swap 就是两元素的 rotate）',
    })
    .optional(),
})

export const drillSchema = z.strictObject({
  version: z.literal(1),
  meta: metaSchema,
  field: fieldSchema,
  objects: z.array(objectSchema).default([]),
  actors: z.array(actorSchema).min(1, { message: '至少要有一个球员或教练' }),
  balls: z.array(ballSchema).default([]),
  variants: z.array(variantSchema).min(1, { message: '至少要有一个练法' }),
})

export type Vec2 = z.infer<typeof vec2Schema>
export type Color = z.infer<typeof colorSchema>
export type PositionRef = z.infer<typeof positionRefSchema>
export type DrillMeta = z.infer<typeof metaSchema>
export type DrillField = z.infer<typeof fieldSchema>
export type DrillObject = z.infer<typeof objectSchema>
export type Actor = z.infer<typeof actorSchema>
export type Ball = z.infer<typeof ballSchema>
export type Action = z.infer<typeof actionSchema>
export type ActionType = Action['type']
export type Phase = z.infer<typeof phaseSchema>
export type Variant = z.infer<typeof variantSchema>
export type Drill = z.infer<typeof drillSchema>

/** 位置引用的窄化判断。 */
export function isAbsolutePos(ref: PositionRef): ref is Vec2 {
  return Array.isArray(ref)
}

export function isRelativePos(ref: PositionRef): ref is { at: string; offset?: Vec2 } {
  return !Array.isArray(ref) && 'at' in ref
}

export function isTowardPos(ref: PositionRef): ref is { toward: string; stopShort: number } {
  return !Array.isArray(ref) && 'toward' in ref
}
