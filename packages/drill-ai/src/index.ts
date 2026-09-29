import { AnthropicProvider } from './anthropicProvider.js'
import { loadAiConfig, type AiConfig } from './config.js'
import { OpenAiProvider } from './openaiProvider.js'
import type { VisionProvider } from './types.js'

/**
 * 按配置造出对应协议的适配器。
 * 上层（提示词、校验、重试）完全不关心用的是哪一家。
 */
export function createProvider(config: AiConfig = loadAiConfig()): VisionProvider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'openai':
      return new OpenAiProvider(config)
  }
}

export { AnthropicProvider } from './anthropicProvider.js'
export { OpenAiProvider } from './openaiProvider.js'
export { describeConfig, loadAiConfig, MissingCredentialError } from './config.js'
export type { AiConfig, AuthStyle, ProviderKind } from './config.js'
export { extractJson } from './extractJson.js'
export { buildSystemPrompt, buildUserInstruction } from './prompt.js'
export { recognizeDrill, validate } from './recognize.js'
export type {
  RecognizeFailure,
  RecognizeOptions,
  RecognizeProgress,
  RecognizeResult,
  RecognizeSuccess,
} from './recognize.js'
export { recognitionSchema } from './types.js'
export type {
  PageImage,
  ProviderRequest,
  ProviderResponse,
  Recognition,
  Usage,
  VisionProvider,
} from './types.js'
