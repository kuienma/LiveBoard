import OpenAI from 'openai'
import type { AiConfig } from './config.js'
import { extractJson } from './extractJson.js'
import { buildUserText } from './anthropicProvider.js'
import type { ProviderRequest, ProviderResponse, VisionProvider } from './types.js'

/**
 * OpenAI Chat Completions 协议适配器（官方 openai SDK）。
 *
 * 用它接各类兼容网关。结构化输出这里用 `response_format: { type: 'json_object' }`——
 * 比 json_schema 的兼容面宽得多，几乎所有兼容网关都支持；schema 的约束由提示词
 * 加上后端的两层校验 + 重试来保证（和 anthropic 侧共用同一套）。
 * 网关连 json_object 都不认时自动退化成纯提示词约束。
 */
export class OpenAiProvider implements VisionProvider {
  readonly kind = 'openai' as const
  readonly model: string

  private readonly client: OpenAI
  private readonly config: AiConfig
  private jsonModeWorks: boolean

  constructor(config: AiConfig) {
    this.config = config
    this.model = config.model
    this.jsonModeWorks = !config.disableStructuredOutput

    const options: Record<string, unknown> = { apiKey: config.apiKey }
    if (config.baseUrl !== undefined) options['baseURL'] = config.baseUrl
    this.client = new OpenAI(options)
  }

  async request(input: ProviderRequest): Promise<ProviderResponse> {
    if (this.jsonModeWorks) {
      try {
        return await this.send(input, true)
      } catch (error) {
        if (!isUnsupportedResponseFormat(error)) throw error
        this.jsonModeWorks = false
      }
    }
    return this.send(input, false)
  }

  private async send(input: ProviderRequest, jsonMode: boolean): Promise<ProviderResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: this.config.maxOutputTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      messages: [
        { role: 'system', content: input.system },
        {
          role: 'user',
          content: [
            // 图片在前、文字在后，和 anthropic 侧保持一致
            ...input.images.map((image) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
            })),
            { type: 'text' as const, text: buildUserText(input) },
          ],
        },
      ],
    })

    const choice = response.choices[0]
    if (choice === undefined) {
      throw new Error('模型没有返回任何 choice')
    }
    if (choice.finish_reason === 'length') {
      throw new Error(
        `模型输出被 max_completion_tokens（${this.config.maxOutputTokens}）截断，JSON 不完整。` +
          '请调大 .env 里的 AI_MAX_OUTPUT_TOKENS。',
      )
    }
    if (choice.finish_reason === 'content_filter') {
      throw new Error('模型因内容过滤拒绝了这次请求')
    }

    const text = choice.message.content ?? ''

    return {
      json: extractJson(text),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
      provider: this.kind,
      structured: jsonMode,
    }
  }
}

function isUnsupportedResponseFormat(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) return false
  if (error.status !== 400 && error.status !== 404 && error.status !== 422) return false
  const message = String(error.message).toLowerCase()
  return [
    'response_format',
    'json_object',
    'json mode',
    'not supported',
    'unsupported',
    'unrecognized',
    'unknown parameter',
  ].some((needle) => message.includes(needle))
}
