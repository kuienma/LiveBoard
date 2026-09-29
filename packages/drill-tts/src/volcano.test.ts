import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { TtsError } from './types.js'
import { VolcanoTtsProvider } from './volcano.js'

/**
 * 按文档 §3.4 的格式伪造 SSE 响应的本地服务器。
 *
 * 这样能在没有真凭证的情况下验证：请求头对不对、请求体结构对不对、
 * 多帧 base64 音频能不能正确拼起来、错误帧有没有翻成中文。
 */
interface Captured {
  headers: Record<string, string | string[] | undefined>
  body: unknown
  path: string
}

let server: Server | undefined

async function startServer(
  handler: (captured: Captured) => { status?: number; frames: string[] } | { status: number; text: string },
): Promise<{ baseUrl: string; captured: Captured[] }> {
  const captured: Captured[] = []

  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const entry: Captured = {
        headers: req.headers,
        body: raw === '' ? undefined : JSON.parse(raw),
        path: req.url ?? '',
      }
      captured.push(entry)

      const result = handler(entry)
      if ('text' in result) {
        res.writeHead(result.status, { 'content-type': 'text/plain' })
        res.end(result.text)
        return
      }
      res.writeHead(result.status ?? 200, { 'content-type': 'text/event-stream' })
      for (const frame of result.frames) res.write(frame)
      res.end()
    })
  })

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, captured }
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
})

/** 一帧 SSE。 */
const frame = (event: number, payload: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`

const audioFrame = (bytes: number[]) =>
  frame(352, { code: 0, message: '', data: Buffer.from(bytes).toString('base64') })

const finishFrame = (characters = 11) =>
  frame(152, { code: 20000000, message: 'OK', data: null, usage: { text_words: characters } })

describe('VolcanoTtsProvider 构造校验', () => {
  it('没给发音人时直接报错，不去猜一个默认音色', () => {
    expect(() => new VolcanoTtsProvider({ speaker: '  ', apiKey: 'k' })).toThrow('必须指定发音人')
  })

  it('两套凭证都没给时报错，并说清二者选一', () => {
    expect(() => new VolcanoTtsProvider({ speaker: 'zh_female_x' })).toThrow('apiKey')
  })
})

describe('请求格式', () => {
  it('走 SSE 单向流式路径，新版控制台只发 X-Api-Key', async () => {
    const { baseUrl, captured } = await startServer(() => ({
      frames: [audioFrame([1, 2, 3]), finishFrame()],
    }))
    const provider = new VolcanoTtsProvider({
      baseUrl,
      apiKey: 'test-key',
      speaker: 'zh_female_vv',
      resourceId: 'seed-tts-2.0',
    })

    await provider.synthesize({ text: '防守者从右边来' })

    const request = captured[0]!
    expect(request.path).toBe('/api/v3/tts/unidirectional/sse')
    expect(request.headers['x-api-key']).toBe('test-key')
    expect(request.headers['x-api-resource-id']).toBe('seed-tts-2.0')
    // 旧版控制台的头不该出现
    expect(request.headers['x-api-app-id']).toBeUndefined()
    // 要计费字符数才能记账
    expect(request.headers['x-control-require-usage-tokens-return']).toBe('text_words')
  })

  it('旧版控制台凭证发 X-Api-App-Id + X-Api-Access-Key', async () => {
    const { baseUrl, captured } = await startServer(() => ({
      frames: [audioFrame([1]), finishFrame()],
    }))
    await new VolcanoTtsProvider({
      baseUrl,
      appId: '123456789',
      accessKey: 'token',
      speaker: 'zh_female_vv',
    }).synthesize({ text: '测试' })

    expect(captured[0]!.headers['x-api-app-id']).toBe('123456789')
    expect(captured[0]!.headers['x-api-access-key']).toBe('token')
    expect(captured[0]!.headers['x-api-key']).toBeUndefined()
  })

  it('请求体按文档嵌套：user / namespace / req_params', async () => {
    const { baseUrl, captured } = await startServer(() => ({
      frames: [audioFrame([1]), finishFrame()],
    }))
    await new VolcanoTtsProvider({
      baseUrl,
      apiKey: 'k',
      speaker: 'zh_female_vv',
      sampleRate: 16000,
      format: 'mp3',
    }).synthesize({ text: '第 1 次：防守者从右边来' })

    const body = captured[0]!.body as {
      user: { uid: string }
      namespace: string
      req_params: {
        text: string
        speaker: string
        audio_params: { format: string; sample_rate: number; speech_rate: number }
      }
    }
    expect(body.namespace).toBe('BidirectionalTTS')
    expect(body.user.uid).toBeTruthy()
    expect(body.req_params.text).toBe('第 1 次：防守者从右边来')
    expect(body.req_params.speaker).toBe('zh_female_vv')
    expect(body.req_params.audio_params.format).toBe('mp3')
    expect(body.req_params.audio_params.sample_rate).toBe(16000)
    expect(body.req_params.audio_params.speech_rate).toBe(0)
  })

  it('语速倍率换成接口的 [-50, 100]：1→0、2→100、0.5→-50', async () => {
    const seen: number[] = []
    const { baseUrl, captured } = await startServer(() => ({
      frames: [audioFrame([1]), finishFrame()],
    }))
    const provider = new VolcanoTtsProvider({ baseUrl, apiKey: 'k', speaker: 'v' })

    for (const speed of [1, 2, 0.5, 5]) {
      await provider.synthesize({ text: '测试', speed })
    }
    for (const entry of captured) {
      const body = entry.body as { req_params: { audio_params: { speech_rate: number } } }
      seen.push(body.req_params.audio_params.speech_rate)
    }
    // 5 倍速要被夹到上限 100
    expect(seen).toEqual([0, 100, -50, 100])
  })

  it('request.voice 覆盖默认发音人', async () => {
    const { baseUrl, captured } = await startServer(() => ({
      frames: [audioFrame([1]), finishFrame()],
    }))
    await new VolcanoTtsProvider({ baseUrl, apiKey: 'k', speaker: '默认音色' }).synthesize({
      text: '测试',
      voice: '指定音色',
    })
    const body = captured[0]!.body as { req_params: { speaker: string } }
    expect(body.req_params.speaker).toBe('指定音色')
  })
})

describe('响应解析', () => {
  it('多帧 base64 音频按顺序拼成完整音频', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [
        audioFrame([0x11, 0x22]),
        frame(351, { code: 0, message: '', data: null, sentence: { text: '一句', words: [] } }),
        audioFrame([0x33]),
        audioFrame([0x44, 0x55]),
        finishFrame(),
      ],
    }))
    const audio = await new VolcanoTtsProvider({
      baseUrl,
      apiKey: 'k',
      speaker: 'v',
    }).synthesize({ text: '测试' })

    expect([...audio.data]).toEqual([0x11, 0x22, 0x33, 0x44, 0x55])
    expect(audio.format).toBe('mp3')
  })

  it('一帧被拆成多个 TCP 包也能正确解析', async () => {
    const full = audioFrame([0xaa, 0xbb]) + finishFrame()
    // 每 7 个字节切一刀，模拟分包
    const pieces: string[] = []
    for (let i = 0; i < full.length; i += 7) pieces.push(full.slice(i, i + 7))

    const { baseUrl } = await startServer(() => ({ frames: pieces }))
    const audio = await new VolcanoTtsProvider({
      baseUrl,
      apiKey: 'k',
      speaker: 'v',
    }).synthesize({ text: '测试' })
    expect([...audio.data]).toEqual([0xaa, 0xbb])
  })

  it('结束帧里的计费字符数会回调出来，便于记账', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [audioFrame([1]), finishFrame(37)],
    }))
    const usage: Array<{ characters: number; text: string }> = []
    await new VolcanoTtsProvider({
      baseUrl,
      apiKey: 'k',
      speaker: 'v',
      onUsage: (entry) => usage.push(entry),
    }).synthesize({ text: '一段说明' })

    expect(usage).toEqual([{ characters: 37, text: '一段说明' }])
  })

  it('pcm 格式按 wav 交给后续流程', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [audioFrame([1]), finishFrame()],
    }))
    const audio = await new VolcanoTtsProvider({
      baseUrl,
      apiKey: 'k',
      speaker: 'v',
      format: 'pcm',
    }).synthesize({ text: '测试' })
    expect(audio.format).toBe('wav')
  })
})

describe('错误处理', () => {
  it('音色鉴权失败给出可操作的中文提示', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [
        frame(153, {
          code: 45000000,
          message: 'speaker permission denied: get resource id: access denied',
        }),
      ],
    }))
    const provider = new VolcanoTtsProvider({ baseUrl, apiKey: 'k', speaker: 'v' })
    await expect(provider.synthesize({ text: '测试' })).rejects.toThrow('音色鉴权失败')
  })

  it('文本超长提示把说明拆短', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [frame(153, { code: 40402003, message: 'TTSExceededTextLimit:exceed max limit' })],
    }))
    await expect(
      new VolcanoTtsProvider({ baseUrl, apiKey: 'k', speaker: 'v' }).synthesize({ text: '长' }),
    ).rejects.toThrow('文本超长')
  })

  it('服务端错误标记为可重试', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [frame(153, { code: 55000000, message: 'internal error' })],
    }))
    const error = await new VolcanoTtsProvider({ baseUrl, apiKey: 'k', speaker: 'v' })
      .synthesize({ text: '测试' })
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(TtsError)
    expect((error as TtsError).retryable).toBe(true)
  })

  it('HTTP 非 200 时把响应体带进报错，便于排查鉴权问题', async () => {
    const { baseUrl } = await startServer(() => ({ status: 401, text: 'api key not granted' }))
    const provider = new VolcanoTtsProvider({ baseUrl, apiKey: 'bad', speaker: 'v' })
    await expect(provider.synthesize({ text: '测试' })).rejects.toThrow('api key not granted')
  })

  it('只有结束帧没有音频时报错，而不是返回空文件', async () => {
    const { baseUrl } = await startServer(() => ({ frames: [finishFrame()] }))
    await expect(
      new VolcanoTtsProvider({ baseUrl, apiKey: 'k', speaker: 'v' }).synthesize({ text: '测试' }),
    ).rejects.toThrow('空音频')
  })

  it('音频流中断（没有结束帧且没音频）报明确原因', async () => {
    const { baseUrl } = await startServer(() => ({ frames: [] }))
    await expect(
      new VolcanoTtsProvider({ baseUrl, apiKey: 'k', speaker: 'v' }).synthesize({ text: '测试' }),
    ).rejects.toThrow('意外中断')
  })
})

describe('端点解析与传输方式', () => {
  /** chunked 响应：首尾相接的 JSON，没有分隔符。 */
  const chunkedAudio = (bytes: number[]) =>
    JSON.stringify({ code: 0, message: '', data: Buffer.from(bytes).toString('base64') })
  const chunkedFinish = (characters = 11) =>
    JSON.stringify({ code: 20000000, message: 'ok', data: null, usage: { text_words: characters } })

  it('给完整的 chunked 端点时按原样请求，不再拼路径', async () => {
    const { baseUrl, captured } = await startServer(() => ({
      frames: [chunkedAudio([1, 2]), chunkedFinish()],
    }))
    await new VolcanoTtsProvider({
      baseUrl: `${baseUrl}/api/v3/tts/unidirectional`,
      apiKey: 'k',
      speaker: 'v',
    }).synthesize({ text: '测试' })

    // 不能变成 .../unidirectional/api/v3/tts/unidirectional/sse
    expect(captured[0]!.path).toBe('/api/v3/tts/unidirectional')
  })

  it('只给主机地址时自动补成 SSE 端点', async () => {
    const { baseUrl, captured } = await startServer(() => ({
      frames: [`event: 352\ndata: ${chunkedAudio([1])}\n\n`, `event: 152\ndata: ${chunkedFinish()}\n\n`],
    }))
    await new VolcanoTtsProvider({ baseUrl, apiKey: 'k', speaker: 'v' }).synthesize({ text: '测试' })
    expect(captured[0]!.path).toBe('/api/v3/tts/unidirectional/sse')
  })

  it('chunked：多个相接的 JSON 对象能正确切开并拼出音频', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [chunkedAudio([0x11]) + chunkedAudio([0x22, 0x33]), chunkedFinish()],
    }))
    const audio = await new VolcanoTtsProvider({
      baseUrl: `${baseUrl}/api/v3/tts/unidirectional`,
      apiKey: 'k',
      speaker: 'v',
    }).synthesize({ text: '测试' })
    expect([...audio.data]).toEqual([0x11, 0x22, 0x33])
  })

  it('chunked：JSON 被 TCP 分包切断也能拼回来', async () => {
    const full = chunkedAudio([0xaa, 0xbb, 0xcc]) + chunkedFinish()
    const pieces: string[] = []
    for (let i = 0; i < full.length; i += 5) pieces.push(full.slice(i, i + 5))

    const { baseUrl } = await startServer(() => ({ frames: pieces }))
    const audio = await new VolcanoTtsProvider({
      baseUrl: `${baseUrl}/api/v3/tts/unidirectional`,
      apiKey: 'k',
      speaker: 'v',
    }).synthesize({ text: '测试' })
    expect([...audio.data]).toEqual([0xaa, 0xbb, 0xcc])
  })

  it('chunked：message 里带花括号也不会把切分搞乱', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [
        JSON.stringify({ code: 0, message: '{不是分隔符}', data: null }) + chunkedAudio([0x7f]),
        chunkedFinish(),
      ],
    }))
    const audio = await new VolcanoTtsProvider({
      baseUrl: `${baseUrl}/api/v3/tts/unidirectional`,
      apiKey: 'k',
      speaker: 'v',
    }).synthesize({ text: '测试' })
    expect([...audio.data]).toEqual([0x7f])
  })

  it('chunked：错误帧同样翻成中文（这一路没有事件号可依赖）', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [
        JSON.stringify({
          code: 45000000,
          message: 'speaker permission denied: get resource id: access denied',
        }),
      ],
    }))
    await expect(
      new VolcanoTtsProvider({
        baseUrl: `${baseUrl}/api/v3/tts/unidirectional`,
        apiKey: 'k',
        speaker: 'v',
      }).synthesize({ text: '测试' }),
    ).rejects.toThrow('音色鉴权失败')
  })

  it('transport 可以显式指定，覆盖自动判断', async () => {
    const { baseUrl } = await startServer(() => ({
      frames: [`event: 352\ndata: ${chunkedAudio([9])}\n\n`, `event: 152\ndata: ${chunkedFinish()}\n\n`],
    }))
    const audio = await new VolcanoTtsProvider({
      baseUrl: `${baseUrl}/api/v3/tts/unidirectional`,
      transport: 'sse',
      apiKey: 'k',
      speaker: 'v',
    }).synthesize({ text: '测试' })
    expect([...audio.data]).toEqual([9])
  })
})
