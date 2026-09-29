import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { openDb, type Db } from './db/index.js'

const provider = {
  kind: 'anthropic' as const,
  model: 'test',
  request: () => Promise.reject(new Error('静态托管测试不该调模型')),
}

let dir: string
let db: Db

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'web-dist-'))
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>战术板动画</title>')
  await writeFile(join(dir, 'assets', 'index-AbCdEfGh12.js'), 'console.log(1)')
  await writeFile(join(dir, 'assets', 'logo.svg'), '<svg/>')
  db = openDb(':memory:')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('托管前端构建产物', () => {
  it('根路径返回 index.html', async () => {
    const app = createApp({ provider, db, webDist: dir })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('战术板动画')
  })

  it('静态兜底不会吃掉 /api——注册顺序错了这条就会红', async () => {
    const app = createApp({ provider, db, webDist: dir })

    const health = await app.request('/api/health')
    expect(health.status).toBe(200)
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true)

    // 训练库接口同样要还在
    const drills = await app.request('/api/drills')
    expect(drills.status).toBe(200)
    expect(drills.headers.get('content-type')).toContain('application/json')
  })

  it('不存在的 /api 路径返回 404 JSON，而不是把 index.html 当接口结果', async () => {
    const app = createApp({ provider, db, webDist: dir })
    const res = await app.request('/api/没有这个接口')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('<!doctype html>')
  })

  it('带 hash 的资源给长期缓存，index.html 不给', async () => {
    const app = createApp({ provider, db, webDist: dir })

    const asset = await app.request('/assets/index-AbCdEfGh12.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')

    const html = await app.request('/')
    expect(html.headers.get('cache-control') ?? '').not.toContain('immutable')
  })

  it('没有 hash 的资源不给长期缓存（改了就该立刻生效）', async () => {
    const app = createApp({ provider, db, webDist: dir })
    const res = await app.request('/assets/logo.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control') ?? '').not.toContain('immutable')
  })

  it('未知页面路径回 index.html，刷新不会白屏', async () => {
    const app = createApp({ provider, db, webDist: dir })
    const res = await app.request('/随便什么路径')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('战术板动画')
  })

  it('不传 webDist 时不托管任何静态文件，接口照常', async () => {
    const app = createApp({ provider, db })
    expect((await app.request('/api/health')).status).toBe(200)
    expect((await app.request('/')).status).toBe(404)
  })
})
