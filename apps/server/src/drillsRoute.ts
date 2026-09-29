import type { Hono } from 'hono'
import type { Db } from './db/index.js'
import { ORIGIN_LABEL, VERSION_ORIGINS, type VersionOrigin } from './db/index.js'
import {
  createDrill,
  deleteDrill,
  duplicateDrill,
  exportDrills,
  getDrill,
  importDrills,
  LibraryError,
  listDrills,
  listVersions,
  restoreVersion,
  updateDrill,
} from './library.js'

/** 把 LibraryError 变成带状态码的响应，其余错误统一 500。 */
function fail(error: unknown): { body: Record<string, unknown>; status: 400 | 404 | 500 } {
  if (error instanceof LibraryError) {
    return {
      body: {
        error: error.status === 404 ? 'not_found' : 'invalid',
        message: error.message,
        ...(error.issues === undefined ? {} : { issues: error.issues }),
      },
      status: error.status === 404 ? 404 : 400,
    }
  }
  return {
    body: { error: 'internal', message: error instanceof Error ? error.message : String(error) },
    status: 500,
  }
}

function parseOrigin(raw: unknown, fallback: VersionOrigin): VersionOrigin {
  const found = VERSION_ORIGINS.find((origin) => origin === raw)
  return found ?? fallback
}

/**
 * 训练库接口（docs/spec.md 第 5 节）。
 *
 * 注意注册顺序：/api/drills/export 必须在 /api/drills/:id 之前，
 * 否则会被 :id 吃掉，export 被当成一个训练 id 去查。
 */
export function registerDrillRoutes(app: Hono, db: Db): void {
  // ── 导出 / 导入（放在 :id 之前）────────────────────────────────
  app.get('/api/drills/export', (c) => {
    try {
      const ids = c.req.queries('id')
      const file = exportDrills(db, ids === undefined || ids.length === 0 ? undefined : ids)
      const stamp = new Date().toISOString().slice(0, 10)
      const name = file.drills.length === 1 ? `${file.drills[0]!.title}` : '训练库'
      return c.json(file, 200, {
        // 让手机浏览器直接当文件保存
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${name}-${stamp}.json`)}`,
      })
    } catch (error) {
      const { body, status } = fail(error)
      return c.json(body, status)
    }
  })

  app.post('/api/drills/import', async (c) => {
    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid', message: '文件内容不是合法的 JSON，可能已损坏' }, 400)
    }
    try {
      return c.json(importDrills(db, payload))
    } catch (error) {
      const { body, status } = fail(error)
      return c.json(body, status)
    }
  })

  // ── 增删改查 ──────────────────────────────────────────────────
  app.get('/api/drills', (c) => {
    const q = c.req.query('q')
    const category = c.req.query('category')
    return c.json({
      drills: listDrills(db, {
        ...(q === undefined ? {} : { q }),
        ...(category === undefined ? {} : { category }),
      }),
    })
  })

  app.post('/api/drills', async (c) => {
    try {
      const body = (await c.req.json()) as {
        drill?: unknown
        origin?: unknown
        thumbnail?: string
      }
      const detail = createDrill(db, {
        drill: body.drill,
        origin: parseOrigin(body.origin, 'manual'),
        ...(body.thumbnail === undefined ? {} : { thumbnail: body.thumbnail }),
      })
      return c.json(detail, 201)
    } catch (error) {
      const { body, status } = fail(error)
      return c.json(body, status)
    }
  })

  app.get('/api/drills/:id', (c) => {
    try {
      return c.json(getDrill(db, c.req.param('id')))
    } catch (error) {
      const { body, status } = fail(error)
      return c.json(body, status)
    }
  })

  app.put('/api/drills/:id', async (c) => {
    try {
      const body = (await c.req.json()) as {
        drill?: unknown
        origin?: unknown
        thumbnail?: string
      }
      const detail = updateDrill(db, c.req.param('id'), {
        drill: body.drill,
        origin: parseOrigin(body.origin, 'manual'),
        ...(body.thumbnail === undefined ? {} : { thumbnail: body.thumbnail }),
      })
      return c.json(detail)
    } catch (error) {
      const { body, status } = fail(error)
      return c.json(body, status)
    }
  })

  app.delete('/api/drills/:id', (c) => {
    try {
      deleteDrill(db, c.req.param('id'))
      return c.json({ ok: true })
    } catch (error) {
      const { body, status } = fail(error)
      return c.json(body, status)
    }
  })

  app.post('/api/drills/:id/duplicate', (c) => {
    try {
      return c.json(duplicateDrill(db, c.req.param('id')), 201)
    } catch (error) {
      const { body, status } = fail(error)
      return c.json(body, status)
    }
  })

  // ── 版本记录 ──────────────────────────────────────────────────
  app.get('/api/drills/:id/versions', (c) => {
    try {
      const versions = listVersions(db, c.req.param('id')).map((version) => ({
        ...version,
        originLabel: ORIGIN_LABEL[version.origin] ?? version.origin,
      }))
      return c.json({ versions })
    } catch (error) {
      const { body, status } = fail(error)
      return c.json(body, status)
    }
  })

  app.post('/api/drills/:id/versions/:versionId/restore', (c) => {
    const versionId = Number.parseInt(c.req.param('versionId'), 10)
    if (!Number.isInteger(versionId)) {
      return c.json({ error: 'invalid', message: '版本 id 必须是整数' }, 400)
    }
    try {
      return c.json(restoreVersion(db, c.req.param('id'), versionId))
    } catch (error) {
      const { body, status } = fail(error)
      return c.json(body, status)
    }
  })
}
