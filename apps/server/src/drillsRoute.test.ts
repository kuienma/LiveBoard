import type { ProviderRequest, ProviderResponse, VisionProvider } from '@drill/ai'
import { beforeEach, describe, expect, it } from 'vitest'
import sideAttack from '../../../fixtures/side-attack.json'
import passingSquare from '../../../fixtures/passing-square.json'
import { createApp } from './app.js'
import { openDb } from './db/index.js'

/** 训练库接口不碰模型，给个永远不被调用的空 provider。 */
const idleProvider: VisionProvider = {
  kind: 'anthropic',
  model: 'unused',
  request: (_input: ProviderRequest): Promise<ProviderResponse> => {
    throw new Error('训练库接口不该调用模型')
  },
}

let app: ReturnType<typeof createApp>

beforeEach(() => {
  app = createApp({ provider: idleProvider, db: openDb(':memory:') })
})

const json = (path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
  })

const create = (drill: unknown = sideAttack) =>
  json('/api/drills', 'POST', { drill, origin: 'recognition' })

describe('增删改查', () => {
  it('POST 新建返回 201 与完整详情', async () => {
    const response = await create()
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.title).toBe('从侧边进攻')
    expect(body.drill.variants).toHaveLength(3)
  })

  it('GET 列表返回摘要（不含完整 drill，省流量）', async () => {
    await create()
    const body = await (await json('/api/drills', 'GET')).json()
    expect(body.drills).toHaveLength(1)
    expect(body.drills[0].title).toBe('从侧边进攻')
    expect(body.drills[0].variantCount).toBe(3)
    expect(body.drills[0]).not.toHaveProperty('drill')
  })

  it('GET 列表支持搜索与筛选', async () => {
    await create(sideAttack)
    await create(passingSquare)

    const searched = await (await json('/api/drills?q=传球', 'GET')).json()
    expect(searched.drills.map((d: any) => d.title)).toEqual(['四角传球'])

    const filtered = await (await json('/api/drills?category=dribbling', 'GET')).json()
    expect(filtered.drills.map((d: any) => d.title)).toEqual(['从侧边进攻'])
  })

  it('GET 单个返回完整 drill', async () => {
    const created = await (await create()).json()
    const body = await (await json(`/api/drills/${created.id}`, 'GET')).json()
    expect(body.drill).toEqual(created.drill)
  })

  it('PUT 更新并记版本', async () => {
    const created = await (await create()).json()
    const edited = structuredClone(created.drill)
    edited.meta.title = '改了'

    const response = await json(`/api/drills/${created.id}`, 'PUT', {
      drill: edited,
      origin: 'manual',
    })
    expect(response.status).toBe(200)
    expect((await response.json()).title).toBe('改了')

    const versions = await (await json(`/api/drills/${created.id}/versions`, 'GET')).json()
    expect(versions.versions).toHaveLength(2)
  })

  it('DELETE 删除', async () => {
    const created = await (await create()).json()
    expect((await json(`/api/drills/${created.id}`, 'DELETE')).status).toBe(200)
    expect((await json(`/api/drills/${created.id}`, 'GET')).status).toBe(404)
  })

  it('不存在的 id 返回 404 与中文原因', async () => {
    const response = await json('/api/drills/nope', 'GET')
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error).toBe('not_found')
    expect(body.message).toContain('找不到')
  })

  it('数据不合法返回 400 并带上校验问题', async () => {
    const broken = structuredClone(sideAttack) as any
    broken.objects[0].pos = [99, 99]
    const response = await create(broken)
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.message).toContain('超出场地范围')
    expect(body.issues.length).toBeGreaterThan(0)
  })

  it('请求体不是 JSON 时不会 500', async () => {
    const response = await app.request('/api/drills', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('internal')
  })
})

describe('复制为新训练', () => {
  it('返回新 id 且标题带「副本」', async () => {
    const created = await (await create()).json()
    const response = await json(`/api/drills/${created.id}/duplicate`, 'POST')
    expect(response.status).toBe(201)
    const copy = await response.json()
    expect(copy.id).not.toBe(created.id)
    expect(copy.title).toBe('从侧边进攻 副本')
  })
})

describe('版本记录', () => {
  it('列表带上中文来源标签', async () => {
    const created = await (await create()).json()
    const body = await (await json(`/api/drills/${created.id}/versions`, 'GET')).json()
    expect(body.versions[0].origin).toBe('recognition')
    expect(body.versions[0].originLabel).toBe('AI 识别')
  })

  it('恢复到指定版本', async () => {
    const created = await (await create()).json()
    const firstVersion = (
      await (await json(`/api/drills/${created.id}/versions`, 'GET')).json()
    ).versions[0]

    const edited = structuredClone(created.drill)
    edited.meta.title = '改了'
    await json(`/api/drills/${created.id}`, 'PUT', { drill: edited, origin: 'manual' })

    const restored = await json(
      `/api/drills/${created.id}/versions/${firstVersion.id}/restore`,
      'POST',
    )
    expect(restored.status).toBe(200)
    expect((await restored.json()).title).toBe('从侧边进攻')
  })

  it('版本 id 不是整数时返回 400', async () => {
    const created = await (await create()).json()
    const response = await json(`/api/drills/${created.id}/versions/abc/restore`, 'POST')
    expect(response.status).toBe(400)
    expect((await response.json()).message).toContain('整数')
  })
})

describe('导出与导入', () => {
  it('/api/drills/export 不会被 :id 路由吃掉', async () => {
    await create()
    const response = await json('/api/drills/export', 'GET')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.format).toBe('drill-library')
    expect(body.drills).toHaveLength(1)
  })

  it('导出带 Content-Disposition，手机能直接存文件', async () => {
    await create()
    const response = await json('/api/drills/export', 'GET')
    const disposition = response.headers.get('Content-Disposition') ?? ''
    expect(disposition).toContain('attachment')
    expect(disposition).toContain(encodeURIComponent('从侧边进攻'))
  })

  it('可以用 ?id= 只导出指定训练', async () => {
    const a = await (await create(sideAttack)).json()
    await create(passingSquare)
    const body = await (await json(`/api/drills/export?id=${a.id}`, 'GET')).json()
    expect(body.drills.map((d: any) => d.title)).toEqual(['从侧边进攻'])
  })

  it('导入合法文件', async () => {
    const a = await (await create()).json()
    const file = await (await json(`/api/drills/export?id=${a.id}`, 'GET')).json()

    const response = await json('/api/drills/import', 'POST', file)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.imported).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('导入损坏的 JSON 返回明确原因', async () => {
    const response = await app.request('/api/drills/import', {
      method: 'POST',
      body: '{ "format": ',
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(400)
    expect((await response.json()).message).toContain('已损坏')
  })

  it('导入格式不对的文件返回明确原因', async () => {
    const response = await json('/api/drills/import', 'POST', { hello: 'world' })
    expect(response.status).toBe(400)
    expect((await response.json()).message).toContain('format')
  })

  it('部分失败时逐条给出原因', async () => {
    const broken = structuredClone(sideAttack) as any
    broken.variants = []
    const response = await json('/api/drills/import', 'POST', {
      format: 'drill-library',
      version: 1,
      exportedAt: new Date().toISOString(),
      drills: [
        { title: '好的', createdAt: 1, drill: sideAttack },
        { title: '坏的', createdAt: 2, drill: broken },
      ],
    })
    const body = await response.json()
    expect(body.imported).toHaveLength(1)
    expect(body.rejected[0].title).toBe('坏的')
    expect(body.rejected[0].reason).toContain('至少要有一个练法')
  })
})
