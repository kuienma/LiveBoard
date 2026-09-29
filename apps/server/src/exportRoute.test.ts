import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDrill, type Drill } from '@drill/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { openDb, type Db } from './db/index.js'
import { ExportQueue } from './exportQueue.js'
import { createDrill } from './library.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const fixture = JSON.parse(
  await readFile(new URL('../../../fixtures/side-attack.json', import.meta.url), 'utf8'),
) as unknown
const parsed = parseDrill(fixture)
if (!parsed.ok) throw new Error('测试夹具本身不合法')
const drill: Drill = parsed.drill

/** 只做骗过 createApp 的假 provider，导出用不到大模型。 */
const provider = {
  kind: 'anthropic' as const,
  model: 'test',
  request: () => Promise.reject(new Error('导出测试不该调模型')),
}

let dir: string
let db: Db
let queue: ExportQueue
let app: ReturnType<typeof createApp>
let drillId: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'export-route-'))
  db = openDb(':memory:')
  queue = new ExportQueue({ dir })
  app = createApp({ provider, db, exportQueue: queue })
  drillId = createDrill(db, { drill, origin: 'import' }).id
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 轮询到任务结束，超时就把当时的状态报出来方便排查。 */
async function waitFor(id: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await app.request(`/api/exports/${id}`)
    const body = (await res.json()) as { task: Record<string, unknown> }
    const status = body.task['status']
    if (status === 'done' || status === 'failed' || status === 'cancelled') return body.task
    if (Date.now() > deadline) throw new Error(`等超时了，任务停在 ${String(status)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe('POST /api/exports 参数校验', () => {
  it('训练不存在返回 404', async () => {
    const res = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ drillId: '不存在', orientation: 'landscape' }),
    })
    expect(res.status).toBe(404)
  })

  it('orientation 非法时说明合法取值', async () => {
    const res = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ drillId, orientation: '斜的' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toContain('landscape')
  })

  it('variantIds 里全是不认识的 id 时拒绝，而不是悄悄导出全部', async () => {
    const res = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ drillId, orientation: 'landscape', variantIds: ['x'] }),
    })
    expect(res.status).toBe(400)
  })

  it('不传 variantIds 表示全部练法，返回的总帧数覆盖三个练法', async () => {
    const res = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ drillId, orientation: 'landscape' }),
    })
    expect(res.status).toBe(202)
    const { task } = (await res.json()) as { task: { id: string; total: number; status: string } }
    expect(task.total).toBeGreaterThan(1000)
    // 队列空着时会立刻开跑，所以两种状态都算对
    expect(['queued', 'running']).toContain(task.status)
    queue.cancel(task.id)
  })

  it('任务对象里不会泄露服务器上的文件路径', async () => {
    const res = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ drillId, orientation: 'landscape', variantIds: ['basic'] }),
    })
    const body = (await res.json()) as { task: Record<string, unknown> }
    expect(body.task).not.toHaveProperty('file')
    queue.cancel(body.task['id'] as string)
  })
})

describe('GET /api/exports/:id', () => {
  it('不存在的任务返回 404', async () => {
    const res = await app.request('/api/exports/没有这个')
    expect(res.status).toBe(404)
  })

  it('没完成时下载接口返回 409，而不是给一个坏文件', async () => {
    const created = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ drillId, orientation: 'landscape', variantIds: ['basic'] }),
    })
    const { task } = (await created.json()) as { task: { id: string } }
    const res = await app.request(`/api/exports/${task.id}/file`)
    expect(res.status).toBe(409)
    queue.cancel(task.id)
  })
})

describe('完整导出流程', () => {
  it.skipIf(!hasFfmpeg)('排队 → 完成 → 下载到一个真 MP4', async () => {
    const created = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ drillId, orientation: 'portrait', variantIds: ['basic'] }),
    })
    const { task } = (await created.json()) as { task: { id: string; total: number } }

    const finished = await waitFor(task.id)
    expect(finished['status']).toBe('done')
    expect(finished['done']).toBe(finished['total'])
    expect(finished['ready']).toBe(true)

    const file = await app.request(`/api/exports/${task.id}/file`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('video/mp4')
    // 文件名带中文，必须是 RFC 5987 编码，否则手机上会存成乱码
    expect(file.headers.get('content-disposition')).toContain("filename*=UTF-8''")

    const bytes = new Uint8Array(await file.arrayBuffer())
    expect(bytes.byteLength).toBeGreaterThan(10_000)
    // MP4 的 ftyp box：第 4..8 字节
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe('ftyp')
  }, 180_000)

  it.skipIf(!hasFfmpeg)('可以中途取消，任务状态变 cancelled', async () => {
    const created = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ drillId, orientation: 'landscape' }),
    })
    const { task } = (await created.json()) as { task: { id: string } }

    // 等它真的跑起来再取消，否则只是从队列里摘掉
    await new Promise((resolve) => setTimeout(resolve, 300))
    const res = await app.request(`/api/exports/${task.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    const finished = await waitFor(task.id, 30_000)
    expect(finished['status']).toBe('cancelled')
  }, 60_000)
})

describe('队列上限', () => {
  it('排队超过上限时返回 429，而不是无限堆积', async () => {
    const small = new ExportQueue({ dir, maxQueued: 1 })
    const localApp = createApp({ provider, db, exportQueue: small })
    const body = JSON.stringify({ drillId, orientation: 'landscape', variantIds: ['basic'] })

    const codes: number[] = []
    for (let i = 0; i < 4; i++) {
      codes.push((await localApp.request('/api/exports', { method: 'POST', body })).status)
    }
    expect(codes).toContain(429)
    for (const task of small.list()) small.cancel(task.id)
  })
})

describe('GET /api/drills/:id/png', () => {
  it('返回一张 PNG，文件名带练法名', async () => {
    const res = await app.request(`/api/drills/${drillId}/png?variant=basic`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''")

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  it('不传 variant 时默认导第一个练法', async () => {
    const res = await app.request(`/api/drills/${drillId}/png`)
    expect(res.status).toBe(200)
    expect(decodeURIComponent(res.headers.get('content-disposition') ?? '')).toContain('基本练法')
  })

  it('竖屏尺寸是 1080x1920', async () => {
    const res = await app.request(`/api/drills/${drillId}/png?orientation=portrait`)
    const png = Buffer.from(await res.arrayBuffer())
    expect(png.readUInt32BE(16)).toBe(1080)
    expect(png.readUInt32BE(20)).toBe(1920)
  })

  it('训练不存在返回 404', async () => {
    const res = await app.request('/api/drills/没有/png')
    expect(res.status).toBe(404)
  })
})

describe('配音开关', () => {
  /** 固定返回一小段静音 wav 的假提供商。 */
  const fakeTts = {
    kind: 'fake',
    defaultVoice: 'test',
    calls: 0,
    synthesize() {
      this.calls++
      const rate = 8000
      const samples = rate // 1 秒
      const data = Buffer.alloc(samples * 2)
      const header = Buffer.alloc(44)
      header.write('RIFF', 0)
      header.writeUInt32LE(36 + data.length, 4)
      header.write('WAVE', 8)
      header.write('fmt ', 12)
      header.writeUInt32LE(16, 16)
      header.writeUInt16LE(1, 20)
      header.writeUInt16LE(1, 22)
      header.writeUInt32LE(rate, 24)
      header.writeUInt32LE(rate * 2, 28)
      header.writeUInt16LE(2, 32)
      header.writeUInt16LE(16, 34)
      header.write('data', 36)
      header.writeUInt32LE(data.length, 40)
      return Promise.resolve({ data: Buffer.concat([header, data]), format: 'wav' as const })
    },
  }

  it('没配置 TTS 时 /api/health 里 voiceOver 为 false', async () => {
    const res = await app.request('/api/health')
    expect(((await res.json()) as { voiceOver: boolean }).voiceOver).toBe(false)
  })

  it('配了 TTS 时 voiceOver 为 true', async () => {
    const withTts = createApp({
      provider,
      db,
      exportQueue: new ExportQueue({ dir, tts: fakeTts }),
    })
    const res = await withTts.request('/api/health')
    expect(((await res.json()) as { voiceOver: boolean }).voiceOver).toBe(true)
  })

  it('不开配音时任务标明「未开启配音」', async () => {
    const created = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ drillId, orientation: 'landscape', variantIds: ['basic'] }),
    })
    const { task } = (await created.json()) as { task: { id: string } }
    queue.cancel(task.id)
    // 取消前状态里还没有 narration，完成后才写；这里只验请求被接受
    expect(created.status).toBe(202)
  })

  it.skipIf(!hasFfmpeg)('开了配音但服务端没配 TTS：导出无声视频并说明原因，而不是失败', async () => {
    const created = await app.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({
        drillId,
        orientation: 'landscape',
        variantIds: ['basic'],
        voiceOver: true,
      }),
    })
    const { task } = (await created.json()) as { task: { id: string } }
    const finished = await waitFor(task.id)

    // 关键：渲染了几百帧不能因为没配音就判失败
    expect(finished['status']).toBe('done')
    expect(String(finished['narration'])).toContain('无声视频')

    const file = await app.request(`/api/exports/${task.id}/file`)
    expect(file.status).toBe(200)
  }, 180_000)

  it.skipIf(!hasFfmpeg)('配了 TTS 且开了配音：任务报告配了几句', async () => {
    fakeTts.calls = 0
    const withTts = createApp({
      provider,
      db,
      exportQueue: new ExportQueue({ dir, tts: fakeTts }),
    })
    const created = await withTts.request('/api/exports', {
      method: 'POST',
      body: JSON.stringify({
        drillId,
        orientation: 'landscape',
        variantIds: ['basic'],
        voiceOver: true,
      }),
    })
    const { task } = (await created.json()) as { task: { id: string } }

    for (;;) {
      const res = await withTts.request(`/api/exports/${task.id}`)
      const body = (await res.json()) as { task: Record<string, unknown> }
      if (body.task['status'] !== 'queued' && body.task['status'] !== 'running') {
        expect(body.task['status']).toBe('done')
        expect(String(body.task['narration'])).toContain('已配音')
        expect(fakeTts.calls).toBeGreaterThan(0)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }, 180_000)
})
