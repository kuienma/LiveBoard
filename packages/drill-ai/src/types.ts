import { drillSchema } from '@drill/schema'
import { z } from 'zod'
import type { ProviderKind } from './config.js'

/** 一页书页照片。 */
export interface PageImage {
  /** image/jpeg、image/png 等。 */
  mediaType: string
  /** 不含 data URI 前缀的 base64。 */
  base64: string
}

/**
 * 模型要返回的东西：训练数据 + 一段中文「我的理解」+ 不确定点列表。
 * 后两项是 docs/spec.md 第 4.1 节明确要求的，用于让用户确认（识别不可能 100% 准确）。
 */
export const recognitionSchema = z.object({
  drill: drillSchema,
  understanding: z
    .string()
    .describe('用中文逐条说明你读懂的训练规则：场地布局、角色、基本练法、每个变化'),
  uncertainties: z
    .array(z.string())
    .describe('你不确定的地方，每条一句中文。没有则给空数组'),
})

export type Recognition = z.infer<typeof recognitionSchema>

export interface ProviderRequest {
  system: string
  /** 随图片一起发的文字指令。 */
  text: string
  images: PageImage[]
  /** 上一轮校验失败时的错误列表，用于重试。 */
  previousAttempt?: { json: string; issues: string }
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface ProviderResponse {
  /** 模型返回的 JSON 文本。 */
  json: string
  usage: Usage
  model: string
  provider: ProviderKind
  /** true 表示真的用上了结构化输出；false 表示退化成「提示词约束 + 自行抽取」。 */
  structured: boolean
}

/**
 * 一个协议适配器。新增一家只要实现这个接口，
 * 上层的提示词、校验、重试逻辑完全不用动。
 */
export interface VisionProvider {
  readonly kind: ProviderKind
  readonly model: string
  request(input: ProviderRequest): Promise<ProviderResponse>
}
