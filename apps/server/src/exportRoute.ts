import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { EXPORT_SIZES, planVariants, renderStillPng, type Orientation } from '@drill/export'
import type { Hono } from 'hono'
import type { Db } from './db/index.js'
import { ExportQueue, QueueFullError, type ExportTask } from './exportQueue.js'
import { getDrill, LibraryError } from './library.js'

const ORIENTATIONS = Object.keys(EXPORT_SIZES) as Orientation[]

function parseOrientation(raw: unknown): Orientation {
  const found = ORIENTATIONS.find((item) => item === raw)
  if (found === undefined) {
    throw new LibraryError(`orientation 只能是 ${ORIENTATIONS.join(' / ')}`, 400)
  }
  return found
}

/** 前端不需要知道文件在服务器上的绝对路径。 */
function publicTask(task: ExportTask) {
  const { file: _file, ...rest } = task
  return { ...rest, ready: task.status === 'done' }
}

/**
 * 视频 / 静态图导出接口（docs/spec.md 第 5 节）。
 *
 * 视频是异步任务：1080p 十几秒的片子要渲染几百帧，
 * 撑在一个 HTTP 请求里会被各级代理的超时掐断。PNG 一帧就够，同步返回。
 */
export function registerExportRoutes(app: Hono, db: Db, queue: ExportQueue): void {
  app.post('/api/exports', async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>
      const drillId = typeof body['drillId'] === 'string' ? body['drillId'] : ''
      const detail = getDrill(db, drillId)

      const orientation = parseOrientation(body['orientation'])
      const requested = Array.isArray(body['variantIds'])
        ? body['variantIds'].filter((item): item is string => typeof item === 'string')
        : []
      // 没指定就导全部练法，顺序按训练里的顺序
      const variantIds =
        requested.length === 0
          ? detail.drill.variants.map((variant) => variant.id)
          : detail.drill.variants
              .filter((variant) => requested.includes(variant.id))
              .map((variant) => variant.id)

      if (variantIds.length === 0) {
        throw new LibraryError('variantIds 里没有一个是这个训练里的练法', 400)
      }

      const totalFrames = planVariants(detail.drill, variantIds).reduce(
        (sum, plan) => sum + plan.frameCount,
        0,
      )

      const task = queue.enqueue(
        {
          drill: detail.drill,
          title: detail.drill.meta.title,
          variantIds,
          orientation,
          showNarration: body['showNarration'] !== false,
          voiceOver: body['voiceOver'] === true,
        },
        totalFrames,
      )

      return c.json({ task: publicTask(task) }, 202)
    } catch (error) {
      if (error instanceof QueueFullError) {
        return c.json({ error: 'busy', message: error.message }, 429)
      }
      if (error instanceof LibraryError) {
        return c.json(
          { error: error.status === 404 ? 'not_found' : 'invalid', message: error.message },
          error.status === 404 ? 404 : 400,
        )
      }
      return c.json(
        { error: 'internal', message: error instanceof Error ? error.message : String(error) },
        500,
      )
    }
  })

  app.get('/api/exports/:id', (c) => {
    const task = queue.get(c.req.param('id'))
    if (task === undefined) {
      return c.json({ error: 'not_found', message: '这个导出任务不存在或已过期' }, 404)
    }
    return c.json({ task: publicTask(task) })
  })

  app.delete('/api/exports/:id', (c) => {
    const ok = queue.cancel(c.req.param('id'))
    if (!ok) {
      return c.json({ error: 'not_found', message: '任务不存在，或已经结束了' }, 404)
    }
    return c.json({ ok: true })
  })

  app.get('/api/exports/:id/file', (c) => {
    const task = queue.get(c.req.param('id'))
    if (task === undefined) {
      return c.json({ error: 'not_found', message: '这个导出任务不存在或已过期' }, 404)
    }
    if (task.status !== 'done' || task.file === undefined) {
      return c.json({ error: 'not_ready', message: `任务还没完成（${task.status}）` }, 409)
    }

    const stream = Readable.toWeb(createReadStream(task.file)) as ReadableStream
    return new Response(stream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(task.bytes ?? 0),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(task.fileName ?? 'drill.mp4')}`,
      },
    })
  })

  // PNG：一个练法一张静态图，同步返回
  app.get('/api/drills/:id/png', (c) => {
    try {
      const detail = getDrill(db, c.req.param('id'))
      const variantId = c.req.query('variant') ?? detail.drill.variants[0]?.id
      if (variantId === undefined) throw new LibraryError('这个训练里没有练法', 400)

      const orientation = parseOrientation(c.req.query('orientation') ?? 'landscape')
      const png = renderStillPng(detail.drill, variantId, { orientation })
      const variant = detail.drill.variants.find((item) => item.id === variantId)
      const name = `${detail.drill.meta.title}-${variant?.name ?? variantId}.png`

      return new Response(new Uint8Array(png), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      })
    } catch (error) {
      if (error instanceof LibraryError) {
        return c.json(
          { error: error.status === 404 ? 'not_found' : 'invalid', message: error.message },
          error.status === 404 ? 404 : 400,
        )
      }
      return c.json(
        { error: 'internal', message: error instanceof Error ? error.message : String(error) },
        500,
      )
    }
  })
}
