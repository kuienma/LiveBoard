import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { AiConfig } from './config.js'
import {
  recognitionSchema,
  type PageImage,
  type ProviderRequest,
  type ProviderResponse,
  type VisionProvider,
} from './types.js'
import { extractJson } from './extractJson.js'

/** Messages API 接受的图片类型。 */
const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number]

function assertMediaType(mediaType: string): SupportedMediaType {
  const normalized = mediaType === 'image/jpg' ? 'image/jpeg' : mediaType
  const hit = SUPPORTED_MEDIA_TYPES.find((allowed) => allowed === normalized)
  if (hit === undefined) {
    throw new Error(
      `不支持的图片类型「${mediaType}」，请转成 JPEG 或 PNG（HEIC 需前端先转码）`,
    )
  }
  return hit
}

/**
 * Anthropic Messages API 适配器（官方 SDK）。
 *
 * 优先用结构化输出（output_config.format）强制符合 Schema；
 * 若网关不支持该参数，自动退化成「提示词约束 + 自行抽取 JSON」并记住，
 * 后续请求不再重试——本地网关常见只转发基础字段。
 */
export class AnthropicProvider implements VisionProvider {
  readonly kind = 'anthropic' as const
  readonly model: string

  private readonly client: Anthropic
  private readonly config: AiConfig
  private structuredOutputWorks: boolean

  constructor(config: AiConfig) {
    this.config = config
    this.model = config.model
    this.structuredOutputWorks = !config.disableStructuredOutput

    const options: Record<string, unknown> = {}
    if (config.baseUrl !== undefined) options['baseURL'] = config.baseUrl
    // 网关签发的 token 走 Authorization: Bearer，官方 Key 走 x-api-key
    if (config.authStyle === 'bearer') {
      options['authToken'] = config.apiKey
      options['apiKey'] = null
    } else {
      options['apiKey'] = config.apiKey
    }
    this.client = new Anthropic(options)
  }

  async request(input: ProviderRequest): Promise<ProviderResponse> {
    const content = this.buildContent(input)

    if (this.structuredOutputWorks) {
      try {
        return await this.requestStructured(input, content)
      } catch (error) {
        if (!isUnsupportedParamError(error)) throw error
        // 网关不认 output_config，退化并记住
        this.structuredOutputWorks = false
      }
    }

    return this.requestPrompted(input, content)
  }

  private async requestStructured(
    input: ProviderRequest,
    content: Anthropic.ContentBlockParam[],
  ): Promise<ProviderResponse> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.config.maxOutputTokens,
      system: input.system,
      messages: [{ role: 'user', content }],
      output_config: {
        format: zodOutputFormat(recognitionSchema),
        ...(this.config.effort === undefined ? {} : { effort: this.config.effort }),
      },
    })

    assertNotRefused(response.stop_reason, response.stop_details)

    const parsed = response.parsed_output
    const json =
      parsed === null || parsed === undefined
        ? extractJson(collectText(response.content))
        : JSON.stringify(parsed)

    return {
      json,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      provider: this.kind,
      structured: true,
    }
  }

  private async requestPrompted(
    input: ProviderRequest,
    content: Anthropic.ContentBlockParam[],
  ): Promise<ProviderResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.config.maxOutputTokens,
      system: input.system,
      messages: [{ role: 'user', content }],
    })

    assertNotRefused(response.stop_reason, response.stop_details)

    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        `模型输出被 max_tokens（${this.config.maxOutputTokens}）截断，JSON 不完整。` +
          '请调大 .env 里的 AI_MAX_OUTPUT_TOKENS。',
      )
    }

    return {
      json: extractJson(collectText(response.content)),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      provider: this.kind,
      structured: false,
    }
  }

  private buildContent(input: ProviderRequest): Anthropic.ContentBlockParam[] {
    // 图片放在文字之前，是 Messages API 推荐的顺序
    const blocks: Anthropic.ContentBlockParam[] = input.images.map((image: PageImage) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: assertMediaType(image.mediaType),
        data: image.base64,
      },
    }))

    blocks.push({ type: 'text', text: buildUserText(input) })
    return blocks
  }
}

/** 重试时把上一轮的产出和校验错误一并带上，让模型有针对性地改。 */
export function buildUserText(input: ProviderRequest): string {
  if (input.previousAttempt === undefined) return input.text

  return [
    input.text,
    '',
    '你上一次的输出没有通过校验。下面是你上次给出的 JSON：',
    '```json',
    input.previousAttempt.json,
    '```',
    '',
    '校验报出的问题（每行一条，冒号前是出错的字段路径）：',
    input.previousAttempt.issues,
    '',
    '请只修正这些问题后重新输出完整结果，不要改动其他已经正确的部分。',
  ].join('\n')
}

function collectText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function assertNotRefused(
  stopReason: string | null,
  stopDetails: { category?: string | null; explanation?: string | null } | null | undefined,
): void {
  if (stopReason !== 'refusal') return
  const category = stopDetails?.category ?? '未说明'
  throw new Error(`模型拒绝了这次请求（类别：${category}）。${stopDetails?.explanation ?? ''}`)
}

/**
 * 判断是不是「网关不认识某个参数」类型的 400。
 * 只在这种情况下退化，其它 400（比如图片太大、模型名不存在）照常抛出。
 */
export function isUnsupportedParamError(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError)) return false
  if (error.status !== 400 && error.status !== 404 && error.status !== 422) return false

  const message = String(error.message).toLowerCase()
  return [
    'output_config',
    'output_format',
    'structured',
    'json_schema',
    'effort',
    'unknown field',
    'unexpected field',
    'unrecognized',
    'not supported',
    'unsupported',
  ].some((needle) => message.includes(needle))
}
