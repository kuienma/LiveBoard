import { randomUUID } from 'node:crypto'
import { TtsError, type TtsAudio, type TtsProvider, type TtsRequest } from './types.js'

/**
 * 火山引擎大模型语音合成（豆包语音）。
 *
 * 走单向流式接口，两种传输都支持：
 * - HTTP Chunked：`POST .../api/v3/tts/unidirectional`
 * - SSE：        `POST .../api/v3/tts/unidirectional/sse`
 * 文档 docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3
 *
 * 两者请求头和请求体完全一样，只有响应分帧不同：SSE 是 `event:` / `data:` 加空行，
 * chunked 是一串首尾相接、没有分隔符的 JSON 对象。
 *
 * 为什么不用 WebSocket 双向流式：我们要的是「一段文字换一段完整音频」，
 * 不需要边合成边播，用不着那套二进制帧协议，也就不用引入 ws 依赖。
 *
 * 判定音频/结束/失败一律看载荷本身（data 是不是非空字符串、code 是不是 20000000），
 * 不依赖事件号——chunked 模式根本没有事件号。
 */

/** 合成结束的成功码（文档 §4）。 */
const CODE_OK = 20000000

export interface VolcanoTtsConfig {
  /**
   * 服务地址。可以是主机根地址（自动补 /api/v3/tts/unidirectional/sse），
   * 也可以直接给完整端点 URL（走自建网关时通常是这种）。
   */
  baseUrl?: string
  /**
   * 响应分帧方式。默认按 baseUrl 末尾自动判断：以 /sse 结尾用 sse，否则用 chunked。
   */
  transport?: 'sse' | 'chunked'
  /**
   * 模型版本与计费方式，对应 X-Api-Resource-Id。
   * seed-tts-2.0 只能用 2.0 的音色，seed-tts-1.0 只能用 1.0 的音色，别混。
   */
  resourceId?: string
  /** 新版控制台：只要 API Key。 */
  apiKey?: string
  /** 旧版控制台：APP ID + Access Token。 */
  appId?: string
  accessKey?: string
  /** 发音人，必填（音色名各家不通用，不设默认值）。 */
  speaker: string
  format?: 'mp3' | 'pcm' | 'ogg_opus'
  sampleRate?: number
  /** 每次调用的计费字符数回调，用于记账（docs/spec.md 第 7 节要求记录用量）。 */
  onUsage?: (usage: { characters: number; text: string }) => void
}

export class VolcanoTtsProvider implements TtsProvider {
  readonly kind = 'volcano'
  readonly defaultVoice: string

  private readonly endpoint: string
  private readonly transport: 'sse' | 'chunked'
  private readonly resourceId: string

  constructor(private readonly config: VolcanoTtsConfig) {
    if (config.speaker.trim() === '') {
      throw new TtsError('必须指定发音人（TTS_VOICE），音色名各家不通用，不能猜一个默认值')
    }
    if (config.apiKey === undefined && (config.appId === undefined || config.accessKey === undefined)) {
      throw new TtsError(
        '缺少凭证：新版控制台给 apiKey，旧版控制台给 appId + accessKey（二者选一）',
      )
    }
    this.defaultVoice = config.speaker
    this.endpoint = resolveEndpoint(config.baseUrl)
    this.transport = config.transport ?? (this.endpoint.endsWith('/sse') ? 'sse' : 'chunked')
    this.resourceId = config.resourceId ?? 'seed-tts-2.0'
  }

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const format = this.config.format ?? 'mp3'
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: this.transport === 'sse' ? 'text/event-stream' : 'application/json',
        ...this.authHeaders(),
        'X-Api-Request-Id': randomUUID(),
        // 让结束帧带上计费字符数，才能记账
        'X-Control-Require-Usage-Tokens-Return': 'text_words',
      },
      body: JSON.stringify({
        user: { uid: 'liveboard' },
        namespace: 'BidirectionalTTS',
        req_params: {
          text: request.text,
          speaker: request.voice ?? this.defaultVoice,
          audio_params: {
            format,
            sample_rate: this.config.sampleRate ?? 24000,
            speech_rate: toSpeechRate(request.speed),
          },
        },
      }),
    }).catch((cause: unknown) => {
      throw new TtsError(
        `连接语音合成服务失败：${cause instanceof Error ? cause.message : String(cause)}`,
        true,
      )
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new TtsError(
        `语音合成返回 HTTP ${response.status}${body === '' ? '' : `：${body.slice(0, 300)}`}`,
        response.status >= 500 || response.status === 429,
      )
    }
    if (response.body === null) throw new TtsError('语音合成没有返回数据流')

    const chunks: Buffer[] = []
    let finished = false

    const payloads =
      this.transport === 'sse' ? readSse(response.body) : readChunkedJson(response.body)

    for await (const payload of payloads) {
      // 音频帧：data 是 base64 字符串
      if (typeof payload.data === 'string' && payload.data !== '') {
        chunks.push(Buffer.from(payload.data, 'base64'))
        continue
      }

      const code = payload.code
      if (code === CODE_OK) {
        finished = true
        const characters = usageCharacters(payload)
        if (characters !== undefined) {
          this.config.onUsage?.({ characters, text: request.text })
        }
        continue
      }

      // code 为 0 且没有音频的是句子/字幕一类的信息帧，忽略
      if (code !== undefined && code !== 0) {
        throw new TtsError(describeError(payload), isRetryable(payload))
      }
    }

    const data = Buffer.concat(chunks)
    if (data.length === 0) {
      throw new TtsError(finished ? '语音合成返回了空音频' : '音频流意外中断', true)
    }
    return { data, format: format === 'pcm' ? 'wav' : 'mp3' }
  }

  private authHeaders(): Record<string, string> {
    // 新版控制台只要 X-Api-Key；旧版要 APP ID + Access Token
    if (this.config.apiKey !== undefined) {
      return { 'X-Api-Key': this.config.apiKey, 'X-Api-Resource-Id': this.resourceId }
    }
    return {
      'X-Api-App-Id': this.config.appId!,
      'X-Api-Access-Key': this.config.accessKey!,
      'X-Api-Resource-Id': this.resourceId,
    }
  }
}

/** 语速：我们用倍率，接口用 [-50, 100]，其中 100 = 2 倍速、-50 = 0.5 倍速。 */
function toSpeechRate(speed: number | undefined): number {
  if (speed === undefined) return 0
  return Math.round(Math.min(Math.max((speed - 1) * 100, -50), 100))
}

interface SsePayload {
  code?: number
  message?: string
  data?: unknown
  usage?: unknown
}

function parsePayload(data: string): SsePayload | undefined {
  if (data === '') return undefined
  try {
    return JSON.parse(data) as SsePayload
  } catch {
    return undefined
  }
}

function usageCharacters(payload: SsePayload): number | undefined {
  const usage = payload.usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const words = (usage as { text_words?: unknown }).text_words
  return typeof words === 'number' ? words : undefined
}

/** 把已知错误码翻成能看懂的中文（文档 §4）。 */
function describeError(payload: SsePayload): string {
  const code = payload.code ?? 0
  const message = payload.message ?? ''
  const hint =
    code === 40402003
      ? '（文本超长，把说明拆短一些）'
      : code === 45000000
        ? '（音色鉴权失败：TTS_VOICE 指定的音色未授权，或与 resource id 的模型版本不匹配）'
        : message.includes('quota exceeded')
          ? '（并发超限，稍后重试）'
          : code === CODE_OK
            ? ''
            : ''
  return `语音合成失败（code ${code}）：${message}${hint}`
}

function isRetryable(payload: SsePayload): boolean {
  const code = payload.code ?? 0
  return code === 55000000 || (payload.message ?? '').includes('quota exceeded')
}

/**
 * 读 SSE 流，逐帧产出 { event, data }。
 *
 * 只按 SSE 最基本的规则解析：空行分帧，`event:` 与 `data:` 两个字段，
 * 多行 data 用换行拼接。够用且不引依赖。
 */
async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SsePayload> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const payload = parseFrame(raw)
      if (payload !== undefined) yield payload
      boundary = buffer.indexOf('\n\n')
    }
  }

  // 末尾可能没有空行收尾
  const last = parseFrame(buffer)
  if (last !== undefined) yield last
}

function parseFrame(raw: string): SsePayload | undefined {
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    // event: 只是提示，判定一律靠载荷里的 code / data
    if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trim())
  }
  if (dataLines.length === 0) return undefined
  return parsePayload(dataLines.join('\n'))
}

/**
 * 读 HTTP Chunked 响应：一串首尾相接、没有分隔符的 JSON 对象。
 *
 * 按花括号配平切分，并且要跳过字符串内部的花括号和转义
 * （message 字段里完全可能出现 `{`）。
 */
async function* readChunkedJson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SsePayload> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })

    for (;;) {
      const end = findObjectEnd(buffer)
      if (end === -1) break
      const payload = parsePayload(buffer.slice(0, end + 1).trim())
      buffer = buffer.slice(end + 1)
      if (payload !== undefined) yield payload
    }
  }

  const tail = parsePayload(buffer.trim())
  if (tail !== undefined) yield tail
}

/** 找出缓冲区里第一个完整 JSON 对象的结束下标，没有就返回 -1。 */
function findObjectEnd(buffer: string): number {
  let depth = 0
  let inString = false
  let escaped = false
  let started = false

  for (let i = 0; i < buffer.length; i++) {
    const char = buffer[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') {
      depth++
      started = true
    } else if (char === '}') {
      depth--
      if (started && depth === 0) return i
    }
  }
  return -1
}

/** 把配置里的地址补成完整端点。 */
function resolveEndpoint(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? 'https://openspeech.bytedance.com').replace(/\/+$/, '')
  // 已经是完整端点就直接用，避免拼成 .../unidirectional/api/v3/tts/unidirectional/sse
  if (trimmed.includes('/api/v3/tts/unidirectional')) return trimmed
  return `${trimmed}/api/v3/tts/unidirectional/sse`
}
