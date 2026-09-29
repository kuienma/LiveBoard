import type { ProviderRequest, ProviderResponse, VisionProvider } from '@drill/ai'
import { beforeAll, describe, expect, it } from 'vitest'
import sideAttack from '../../../fixtures/side-attack.json'
import { createApp, type AppOptions } from './app.js'
import { openDb } from './db/index.js'
import { RateLimiter } from './rateLimit.js'

/** 每个用例一个独立的内存库，互不干扰。 */
const makeApp = (options: Omit<AppOptions, 'db'>) => createApp({ ...options, db: openDb(':memory:') })

/** 假 provider，按脚本回放，不联网。 */
class FakeProvider implements VisionProvider {
  readonly kind = 'anthropic' as const
  readonly model = 'fake-model'
  calls = 0

  constructor(private readonly replies: string[]) {}

  request(_input: ProviderRequest): Promise<ProviderResponse> {
    const json = this.replies[Math.min(this.calls, this.replies.length - 1)]!
    this.calls++
    return Promise.resolve({
      json,
      usage: { inputTokens: 10, outputTokens: 20 },
      model: this.model,
      provider: this.kind,
      structured: false,
    })
  }
}

const goodReply = JSON.stringify({
  drill: sideAttack,
  understanding: '这是一个运球训练',
  uncertainties: ['场地尺寸是估的'],
})

/** 一张最小的合法 PNG（1×1）。这里只测上传管线，不进模型。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC',
  'base64',
)

function formWith(files: Array<{ name: string; type: string; bytes?: Buffer }>): FormData {
  const form = new FormData()
  for (const file of files) {
    form.append(
      'pages',
      new File([new Uint8Array(file.bytes ?? PNG_BYTES)], file.name, { type: file.type }),
    )
  }
  return form
}

interface SseEvent {
  event: string
  data: any
}

/** 把 SSE 响应体解析成事件列表。 */
async function readSse(response: Response): Promise<SseEvent[]> {
  const text = await response.text()
  const events: SseEvent[] = []
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n')
    const eventLine = lines.find((l) => l.startsWith('event:'))
    const dataLine = lines.find((l) => l.startsWith('data:'))
    if (eventLine === undefined || dataLine === undefined) continue
    events.push({
      event: eventLine.slice('event:'.length).trim(),
      data: JSON.parse(dataLine.slice('data:'.length).trim()),
    })
  }
  return events
}

const post = (app: ReturnType<typeof makeApp>, form: FormData, headers: HeadersInit = {}) =>
  app.request('/api/recognize', { method: 'POST', body: form, headers })

describe('GET /api/health', () => {
  it('返回可用状态与模型信息，不泄露密钥', async () => {
    const app = makeApp({ provider: new FakeProvider([goodReply]) })
    const response = await app.request('/api/health')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/sk-|Bearer/)
  })
})

describe('POST /api/recognize 的入参校验', () => {
  let app: ReturnType<typeof makeApp>
  beforeAll(() => {
    app = makeApp({ provider: new FakeProvider([goodReply]) })
  })

  it('没有图片时 400 并说明字段名', async () => {
    const response = await post(app, new FormData())
    expect(response.status).toBe(400)
    expect((await response.json()).message).toContain('pages')
  })

  it('页数超上限时 400', async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ name: `p${i}.png`, type: 'image/png' }))
    const response = await post(app, formWith(files))
    expect(response.status).toBe(400)
    expect((await response.json()).message).toContain('最多 6 页')
  })

  it('不支持的图片类型时 400，并提示 HEIC 要前端转码', async () => {
    const response = await post(app, formWith([{ name: 'a.heic', type: 'image/heic' }]))
    expect(response.status).toBe(400)
    const message = (await response.json()).message
    expect(message).toContain('不支持的图片类型')
    expect(message).toContain('HEIC')
  })

  it('单页过大时 400', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 1)
    const response = await post(app, formWith([{ name: 'big.png', type: 'image/png', bytes: big }]))
    expect(response.status).toBe(400)
    expect((await response.json()).message).toContain('MB')
  })
})

describe('POST /api/recognize 的识别流程', () => {
  it('成功时依次推进度，最后给出结果与不确定点', async () => {
    const provider = new FakeProvider([goodReply])
    const app = makeApp({ provider })
    const response = await post(app, formWith([{ name: 'p.png', type: 'image/png' }]))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const events = await readSse(response)
    const phases = events.filter((e) => e.event === 'progress').map((e) => e.data.phase)
    expect(phases).toEqual(['received', 'requesting', 'validating'])

    const result = events.find((e) => e.event === 'result')!
    expect(result.data.ok).toBe(true)
    expect(result.data.drill.meta.title).toBe('从侧边进攻')
    expect(result.data.drill.variants).toHaveLength(3)
    expect(result.data.understanding).toBe('这是一个运球训练')
    expect(result.data.uncertainties).toEqual(['场地尺寸是估的'])
    expect(result.data.meta.attempts).toBe(1)
    expect(result.data.meta.usage.inputTokens).toBe(10)
  })

  it('多页会一并交给模型', async () => {
    const provider = new FakeProvider([goodReply])
    const app = makeApp({ provider })
    const response = await post(
      app,
      formWith([
        { name: 'p1.png', type: 'image/png' },
        { name: 'p2.jpg', type: 'image/jpeg' },
      ]),
    )
    const events = await readSse(response)
    expect(events[0]!.data).toEqual({ phase: 'received', pages: 2 })
  })

  it('第一次校验失败会推 retrying 事件并带上问题数', async () => {
    const provider = new FakeProvider(['{"drill":{}}', goodReply])
    const app = makeApp({ provider })
    const response = await post(app, formWith([{ name: 'p.png', type: 'image/png' }]))

    const events = await readSse(response)
    const retrying = events.find((e) => e.event === 'progress' && e.data.phase === 'retrying')!
    expect(retrying.data.issueCount).toBeGreaterThan(0)
    expect(typeof retrying.data.issues).toBe('string')

    const result = events.find((e) => e.event === 'result')!
    expect(result.data.ok).toBe(true)
    expect(result.data.meta.attempts).toBe(2)
  })

  it('两次重试仍失败时给出明确提示，不白屏', async () => {
    const provider = new FakeProvider(['我看不清这张图'])
    const app = makeApp({ provider })
    const response = await post(app, formWith([{ name: 'p.png', type: 'image/png' }]))

    const events = await readSse(response)
    const result = events.find((e) => e.event === 'result')!
    expect(result.data.ok).toBe(false)
    expect(result.data.kind).toBe('invalid')
    expect(result.data.message).toContain('3 次')
    expect(result.data.message).toContain('换一张')
    expect(result.data.issues).toBeTruthy()
    expect(result.data).not.toHaveProperty('drill')
    expect(provider.calls).toBe(3)
  })

  it('模型判断不是训练图时给出 not_recognizable，而不是识别成功', async () => {
    const provider = new FakeProvider([
      JSON.stringify({ recognizable: false, understanding: '这是一张收据。' }),
    ])
    const app = makeApp({ provider })
    const response = await post(app, formWith([{ name: 'p.png', type: 'image/png' }]))

    const events = await readSse(response)
    const result = events.find((e) => e.event === 'result')!
    expect(result.data.ok).toBe(false)
    expect(result.data.kind).toBe('not_recognizable')
    expect(result.data.message).toContain('收据')
    expect(provider.calls).toBe(1) // 不重试
  })

  it('模型请求抛错时以 error 事件返回，不是静默失败', async () => {
    const broken: VisionProvider = {
      kind: 'anthropic',
      model: 'x',
      request: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:38080')),
    }
    const app = makeApp({ provider: broken })
    const response = await post(app, formWith([{ name: 'p.png', type: 'image/png' }]))

    const events = await readSse(response)
    const error = events.find((e) => e.event === 'error')!
    expect(error.data.message).toContain('ECONNREFUSED')
  })
})

describe('限频', () => {
  it('超额后返回 429 与 Retry-After，且不再调用模型', async () => {
    const provider = new FakeProvider([goodReply])
    const app = makeApp({ provider, rateLimiter: new RateLimiter(1) })
    const headers = { 'x-forwarded-for': '203.0.113.9' }

    const first = await post(app, formWith([{ name: 'p.png', type: 'image/png' }]), headers)
    expect(first.status).toBe(200)
    await first.text()

    const second = await post(app, formWith([{ name: 'p.png', type: 'image/png' }]), headers)
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBeTruthy()
    const body = await second.json()
    expect(body.error).toBe('rate_limited')
    expect(body.message).toContain('每小时最多 1 次')

    expect(provider.calls).toBe(1)
  })

  it('不同 IP 各自计额', async () => {
    const app = makeApp({ provider: new FakeProvider([goodReply]), rateLimiter: new RateLimiter(1) })
    const a = await post(app, formWith([{ name: 'p.png', type: 'image/png' }]), {
      'x-forwarded-for': '198.51.100.1',
    })
    await a.text()
    const b = await post(app, formWith([{ name: 'p.png', type: 'image/png' }]), {
      'x-forwarded-for': '198.51.100.2',
    })
    expect(b.status).toBe(200)
    await b.text()
  })
})
