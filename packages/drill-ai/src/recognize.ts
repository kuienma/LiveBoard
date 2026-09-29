import { formatIssues, parseDrill, type Drill, type DrillIssue } from '@drill/schema'
import { z } from 'zod'
import type { ProviderKind } from './config.js'
import { buildSystemPrompt, buildUserInstruction } from './prompt.js'
import type { PageImage, Usage, VisionProvider } from './types.js'

/** 模型输出的外层信封。drill 先按 unknown 收下，再交给 parseDrill 做两层校验。 */
const envelopeSchema = z.object({
  // 必须 optional：recognizable 为 false 时模型不会给 drill
  drill: z.unknown().optional(),
  understanding: z.string().default(''),
  uncertainties: z.array(z.string()).default([]),
  /**
   * 模型判断这一页根本不是训练图、或信息不足以还原训练时置 false。
   * 有了这个出口，模型就不会为了凑格式编一份空壳数据——那种数据字段齐全、
   * 能通过校验，却渲染不出任何东西，比直接报错更糟。
   */
  recognizable: z.boolean().default(true),
})

export interface RecognizeSuccess {
  ok: true
  drill: Drill
  understanding: string
  uncertainties: string[]
  /** 总共请求了几次模型（1 表示一次过）。 */
  attempts: number
  usage: Usage
  model: string
  provider: ProviderKind
  /** 是否用上了结构化输出。 */
  structured: boolean
}

export interface RecognizeFailure {
  ok: false
  /**
   * not_recognizable：模型明确表示这一页不是训练图（不重试，直接返回）。
   * invalid：产出的数据反复通不过校验。
   */
  kind: 'not_recognizable' | 'invalid'
  /** kind 为 not_recognizable 时，模型给出的原因。 */
  reason?: string
  attempts: number
  /** 最后一次的错误列表。kind 为 not_recognizable 时为空数组。 */
  issues: DrillIssue[]
  /** 最后一次模型返回的原始 JSON，便于排查。 */
  lastJson?: string
  usage: Usage
  model: string
  provider: ProviderKind
}

export type RecognizeResult = RecognizeSuccess | RecognizeFailure

export interface RecognizeOptions {
  /** 校验失败后最多再重试几次，默认 2（docs/spec.md 第 4.1 节）。 */
  maxRetries?: number
  /** 每一步的进度回调，用于前端显示「上传中 / 识别中 / 校验中」。 */
  onProgress?: (event: RecognizeProgress) => void
}

export type RecognizeProgress =
  | { phase: 'requesting'; attempt: number }
  | { phase: 'validating'; attempt: number }
  | { phase: 'retrying'; attempt: number; issues: DrillIssue[] }

/**
 * 识别一页（或多页）书页照片，产出通过校验的 Drill JSON。
 *
 * 校验失败就把错误列表连同上一轮的产出发回模型重试，最多 maxRetries 次；
 * 仍然失败则如实返回失败和错误列表，绝不返回没过校验的数据。
 */
export async function recognizeDrill(
  provider: VisionProvider,
  images: PageImage[],
  options: RecognizeOptions = {},
): Promise<RecognizeResult> {
  if (images.length === 0) {
    throw new Error('至少需要一张图片')
  }

  const maxRetries = options.maxRetries ?? 2
  const system = buildSystemPrompt()
  const text = buildUserInstruction(images.length)

  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let previousAttempt: { json: string; issues: string } | undefined
  let lastIssues: DrillIssue[] = []
  let lastJson: string | undefined
  let structured = false
  let model = provider.model

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    options.onProgress?.({ phase: 'requesting', attempt })

    const response = await provider.request({
      system,
      text,
      images,
      ...(previousAttempt === undefined ? {} : { previousAttempt }),
    })

    usage.inputTokens += response.usage.inputTokens
    usage.outputTokens += response.usage.outputTokens
    structured = response.structured
    model = response.model
    lastJson = response.json

    options.onProgress?.({ phase: 'validating', attempt })
    const checked = validate(response.json)

    // 模型说这一页不是训练图：重试只会浪费钱，直接如实返回
    if (!checked.ok && checked.kind === 'not_recognizable') {
      return {
        ok: false,
        kind: 'not_recognizable',
        reason: checked.reason,
        issues: [],
        attempts: attempt,
        usage,
        model,
        provider: provider.kind,
      }
    }

    if (checked.ok) {
      return {
        ok: true,
        drill: checked.drill,
        understanding: checked.understanding,
        uncertainties: checked.uncertainties,
        attempts: attempt,
        usage,
        model,
        provider: provider.kind,
        structured,
      }
    }

    lastIssues = checked.issues
    if (attempt <= maxRetries) {
      options.onProgress?.({ phase: 'retrying', attempt, issues: checked.issues })
      previousAttempt = { json: response.json, issues: formatIssues(checked.issues) }
    }
  }

  return {
    ok: false,
    kind: 'invalid',
    attempts: maxRetries + 1,
    issues: lastIssues,
    ...(lastJson === undefined ? {} : { lastJson }),
    usage,
    model,
    provider: provider.kind,
  }
}

type ValidateResult =
  | { ok: true; drill: Drill; understanding: string; uncertainties: string[] }
  | { ok: false; kind: 'not_recognizable'; reason: string }
  | { ok: false; kind: 'invalid'; issues: DrillIssue[] }

/** 解析并校验模型输出。JSON 语法错误、信封结构错误、Drill 校验错误都归一成 DrillIssue。 */
export function validate(json: string): ValidateResult {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (error) {
    return {
      ok: false,
      kind: 'invalid',
      issues: [
        {
          path: '',
          message: `输出不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    }
  }

  const envelope = envelopeSchema.safeParse(raw)
  if (!envelope.success) {
    return {
      ok: false,
      kind: 'invalid',
      issues: [
        {
          path: '',
          message:
            '顶层结构不对，应当是 { "drill": {...}, "understanding": "...", "uncertainties": [...] }',
        },
      ],
    }
  }

  // drill 是 optional（recognizable=false 时模型不给），所以这里要显式检查：
  // 既没说「识别不了」又没给 drill，说明模型没按信封格式输出
  if (envelope.data.recognizable !== false && envelope.data.drill === undefined) {
    return {
      ok: false,
      kind: 'invalid',
      issues: [
        {
          path: '',
          message:
            '顶层结构不对，应当是 { "drill": {...}, "understanding": "...", "uncertainties": [...] }；' +
            '如果这一页无法识别，请输出 { "recognizable": false, "understanding": "原因" }',
        },
      ],
    }
  }

  if (envelope.data.recognizable === false) {
    return {
      ok: false,
      kind: 'not_recognizable',
      reason:
        envelope.data.understanding.trim() === ''
          ? '模型判断这一页不是足球训练教材，或图文信息不足以还原训练。'
          : envelope.data.understanding.trim(),
    }
  }

  const result = parseDrill(envelope.data.drill)
  if (!result.ok) {
    // 把路径挪到 drill. 之下，和模型看到的输出结构对齐
    return {
      ok: false,
      kind: 'invalid',
      issues: result.issues.map((issue) => ({
        path: issue.path === '' ? 'drill' : `drill.${issue.path}`,
        message: issue.message,
      })),
    }
  }

  return {
    ok: true,
    drill: result.drill,
    understanding: envelope.data.understanding,
    uncertainties: envelope.data.uncertainties,
  }
}
