/**
 * 大模型接入配置。
 *
 * 刻意不和任何一家绑定：协议、模型、地址、凭据全从环境变量来，
 * 换网关或换成 OpenAI 协议只改 .env，不改代码（docs/spec.md 第 4.1 节要求
 * 模型名和 API Key 放在环境变量里，不写死在代码中）。
 */

export type ProviderKind = 'anthropic' | 'openai'
export type AuthStyle = 'bearer' | 'x-api-key'

export interface AiConfig {
  kind: ProviderKind
  model: string
  /** 留空表示用该 SDK 的官方默认地址。 */
  baseUrl?: string
  apiKey: string
  authStyle: AuthStyle
  maxOutputTokens: number
  /** anthropic 协议的思考档位；openai 协议下忽略。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** 网关不支持结构化输出时，改用「提示词约束 + 自行抽取 JSON」。 */
  disableStructuredOutput: boolean
}

export class MissingCredentialError extends Error {
  constructor() {
    super(
      '没有找到大模型凭据。请在项目根目录的 .env 里设置 AI_API_KEY' +
        '（或 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / OPENAI_API_KEY），' +
        '可参考 .env.example。',
    )
    this.name = 'MissingCredentialError'
  }
}

type Env = Record<string, string | undefined>

const firstNonEmpty = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return undefined
}

const DEFAULT_MODEL: Record<ProviderKind, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o',
}

/**
 * 从环境变量读配置。AI_* 优先，其次回退到各家自己的惯用变量名，
 * 这样已经配好 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 的机器可以直接跑。
 */
export function loadAiConfig(env: Env = process.env): AiConfig {
  const kind = parseKind(env['AI_PROVIDER'])

  const apiKey = firstNonEmpty(
    env['AI_API_KEY'],
    kind === 'anthropic' ? env['ANTHROPIC_AUTH_TOKEN'] : undefined,
    kind === 'anthropic' ? env['ANTHROPIC_API_KEY'] : undefined,
    kind === 'openai' ? env['OPENAI_API_KEY'] : undefined,
  )
  if (apiKey === undefined) throw new MissingCredentialError()

  const baseUrl = firstNonEmpty(
    env['AI_BASE_URL'],
    kind === 'anthropic' ? env['ANTHROPIC_BASE_URL'] : env['OPENAI_BASE_URL'],
  )

  const config: AiConfig = {
    kind,
    model:
      firstNonEmpty(env['AI_MODEL'], kind === 'anthropic' ? env['ANTHROPIC_MODEL'] : env['OPENAI_MODEL']) ??
      DEFAULT_MODEL[kind],
    apiKey,
    authStyle: resolveAuthStyle(env, kind),
    maxOutputTokens: parsePositiveInt(env['AI_MAX_OUTPUT_TOKENS'], 16000),
    disableStructuredOutput: parseBool(env['AI_DISABLE_STRUCTURED_OUTPUT']),
  }

  if (baseUrl !== undefined) config.baseUrl = baseUrl

  const effort = parseEffort(env['AI_EFFORT'])
  if (effort !== undefined) config.effort = effort

  return config
}

function parseKind(raw: string | undefined): ProviderKind {
  const value = raw?.trim().toLowerCase()
  if (value === undefined || value === '') return 'anthropic'
  if (value === 'anthropic' || value === 'claude') return 'anthropic'
  if (value === 'openai' || value === 'openai-compatible') return 'openai'
  throw new Error(`AI_PROVIDER 只支持 anthropic 或 openai，收到「${raw}」`)
}

/**
 * anthropic 协议有两种放凭据的方式：网关签发的 token 走 Authorization: Bearer，
 * 官方 API Key 走 x-api-key。没显式指定时按凭据来源猜。
 */
function resolveAuthStyle(env: Env, kind: ProviderKind): AuthStyle {
  const explicit = env['AI_AUTH_STYLE']?.trim().toLowerCase()
  if (explicit === 'bearer') return 'bearer'
  if (explicit === 'x-api-key') return 'x-api-key'
  if (explicit !== undefined && explicit !== '') {
    throw new Error(`AI_AUTH_STYLE 只支持 bearer 或 x-api-key，收到「${explicit}」`)
  }

  if (kind === 'openai') return 'bearer'
  // 显式给了 AI_API_KEY 或 ANTHROPIC_AUTH_TOKEN 的，一般是网关 token
  if (firstNonEmpty(env['AI_API_KEY'], env['ANTHROPIC_AUTH_TOKEN']) !== undefined) return 'bearer'
  return 'x-api-key'
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`期望一个正整数，收到「${raw}」`)
  }
  return value
}

function parseBool(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function parseEffort(raw: string | undefined): AiConfig['effort'] {
  const value = raw?.trim().toLowerCase()
  if (value === undefined || value === '') return undefined
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  ) {
    return value
  }
  throw new Error(`AI_EFFORT 只支持 low/medium/high/xhigh/max，收到「${raw}」`)
}

/** 把配置里的敏感字段脱敏后输出，用于日志和 /api/health。 */
export function describeConfig(config: AiConfig): Record<string, unknown> {
  return {
    provider: config.kind,
    model: config.model,
    baseUrl: config.baseUrl ?? '(官方默认)',
    authStyle: config.authStyle,
    apiKey: `${config.apiKey.slice(0, 4)}…（${config.apiKey.length} 位）`,
    maxOutputTokens: config.maxOutputTokens,
    effort: config.effort ?? '(不发送)',
    structuredOutput: config.disableStructuredOutput ? '关闭' : '开启',
  }
}
