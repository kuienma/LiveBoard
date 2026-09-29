import { describeConfig, recognizeDrill, type AiConfig, type PageImage, type VisionProvider } from '@drill/ai'
import { formatIssues } from '@drill/schema'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Db } from './db/index.js'
import { registerDrillRoutes } from './drillsRoute.js'
import type { ExportQueue } from './exportQueue.js'
import { registerExportRoutes } from './exportRoute.js'
import { RateLimiter } from './rateLimit.js'

/** 单页上限。前端会先压到长边约 2000px，正常在 1MB 以内。 */
const MAX_BYTES_PER_PAGE = 8 * 1024 * 1024
/** 一个训练最多跨几页。 */
const MAX_PAGES = 6

/** Vite 产物的文件名形如 index-BJSZkO62.js，改了内容 hash 就会变。 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.(js|css)$/

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export interface AppOptions {
  /** 注入 provider 便于测试；生产由 createProvider() 提供。 */
  provider: VisionProvider
  /** 训练库的数据库。测试传 openDb(':memory:')。 */
  db: Db
  /** 用于 /api/health 的脱敏展示。 */
  config?: AiConfig
  rateLimiter?: RateLimiter
  /** 校验失败后的重试次数，默认 2。 */
  maxRetries?: number
  /** 视频导出队列。不传就不注册导出接口（测试里大多用不到）。 */
  exportQueue?: ExportQueue
  /**
   * 前端构建产物目录。传了就由本服务一起托管，前后端同源、只开一个端口。
   *
   * 同源是 PWA 的前提（Service Worker 只能控制同源页面），
   * 也省掉了生产环境再配一层反向代理做 /api 转发。
   */
  webDist?: string
}

export function createApp(options: AppOptions) {
  const { provider, config, maxRetries, db } = options
  const limiter =
    options.rateLimiter ??
    new RateLimiter(Number.parseInt(process.env['RECOGNIZE_RATE_LIMIT_PER_HOUR'] ?? '20', 10))

  const app = new Hono()

  registerDrillRoutes(app, db)
  if (options.exportQueue !== undefined) registerExportRoutes(app, db, options.exportQueue)

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      /** 前端据此决定要不要显示「加中文配音」开关。 */
      voiceOver: options.exportQueue?.canNarrate() ?? false,
      ai: config === undefined ? { provider: provider.kind, model: provider.model } : describeConfig(config),
    }),
  )

  /**
   * 上传书页照片，流式返回识别进度和结果。
   *
   * 用 SSE 而不是「等 30 秒再返回一个 JSON」：实测单页识别约 33 秒，
   * 期间必须让用户看到「识别中 / 校验中 / 正在重试」，否则以为卡死了。
   *
   * 照片只在内存里待到识别结束，不落盘（docs/spec.md 第 7 节：默认不长期保存原始书页照片）。
   */
  app.post('/api/recognize', async (c) => {
    const ip = clientIp(c.req.raw, c.req.header('x-forwarded-for'))
    const quota = limiter.check(ip)
    if (!quota.allowed) {
      return c.json(
        {
          error: 'rate_limited',
          message: `识别接口每小时最多 ${quota.limit} 次，请 ${Math.ceil(quota.retryAfterSeconds / 60)} 分钟后再试。`,
          retryAfterSeconds: quota.retryAfterSeconds,
        },
        429,
        { 'Retry-After': String(quota.retryAfterSeconds) },
      )
    }

    let images: PageImage[]
    try {
      images = await readImages(c.req.raw)
    } catch (error) {
      return c.json(
        { error: 'bad_request', message: error instanceof Error ? error.message : String(error) },
        400,
      )
    }

    const startedAt = Date.now()

    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) })

      await send('progress', { phase: 'received', pages: images.length })

      /** 每次识别都记一行：docs/spec.md 第 7 节要求记录 token 用量以控成本。 */
      const log = (outcome: string, usage?: { inputTokens: number; outputTokens: number }, attempts?: number) => {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
        const tokens = usage === undefined ? '-' : `${usage.inputTokens}+${usage.outputTokens}`
        console.log(
          `[recognize] ip=${ip} pages=${images.length} outcome=${outcome} ` +
            `attempts=${attempts ?? '-'} tokens=${tokens} ${seconds}s quota=${quota.used}/${quota.limit}`,
        )
      }

      try {
        const result = await recognizeDrill(provider, images, {
          ...(maxRetries === undefined ? {} : { maxRetries }),
          onProgress: (event) => {
            // onProgress 是同步回调，这里不 await，靠 SSE 自身顺序保证
            void send('progress', {
              phase: event.phase,
              attempt: event.attempt,
              ...(event.phase === 'retrying'
                ? { issueCount: event.issues.length, issues: formatIssues(event.issues) }
                : {}),
            })
          },
        })

        if (result.ok) {
          log('ok', result.usage, result.attempts)
          await send('result', {
            ok: true,
            drill: result.drill,
            understanding: result.understanding,
            uncertainties: result.uncertainties,
            meta: {
              attempts: result.attempts,
              usage: result.usage,
              model: result.model,
              provider: result.provider,
              structured: result.structured,
            },
          })
        } else if (result.kind === 'not_recognizable') {
          log('not_recognizable', result.usage, result.attempts)
          // 模型明确说这一页不是训练图：不是 bug，也不该显示成识别成功
          await send('result', {
            ok: false,
            kind: 'not_recognizable',
            message: result.reason ?? '这一页看起来不是足球训练教材。',
            meta: {
              attempts: result.attempts,
              usage: result.usage,
              model: result.model,
              provider: result.provider,
            },
          })
        } else {
          log('invalid', result.usage, result.attempts)
          // 两次重试仍失败：给出明确提示，不白屏（阶段二验收项）
          await send('result', {
            ok: false,
            kind: 'invalid',
            message:
              `模型尝试了 ${result.attempts} 次，产出的数据都没通过校验。` +
              '可以换一张更清晰、包含完整文字说明的照片再试，或手动创建训练。',
            issues: formatIssues(result.issues),
            meta: {
              attempts: result.attempts,
              usage: result.usage,
              model: result.model,
              provider: result.provider,
            },
          })
        }
      } catch (error) {
        log('error')
        // 网关不通、凭据错误、图片被拒等：SSE 已经开始，只能用事件传错误
        await send('error', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })
  })

  /**
   * 托管前端。必须放在所有 /api 路由之后注册，否则静态兜底会把接口吃掉。
   *
   * 路由是 hash 形式（#/drill/xxx），所以不需要 history fallback：
   * 浏览器请求的路径永远是 /，hash 部分不发给服务端。
   */
  if (options.webDist !== undefined) {
    const root = options.webDist

    /**
     * 带内容 hash 的资源可以长期缓存，index.html 绝对不能。
     *
     * 缓存头必须在外层中间件里、等 serveStatic 生成响应之后再设：
     * serveStatic 的 onFound 里用 c.header() 设的头会被最终 Response 丢掉（实测）。
     */
    app.use('/assets/*', async (c, next) => {
      await next()
      if (c.res.status === 200 && HASHED_ASSET.test(c.req.path)) {
        c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      }
    })

    /**
     * 不存在的接口要回 404 JSON，不能落到下面的 SPA 兜底。
     * 否则前端拿到的是 200 + HTML，request() 去 JSON.parse 会报一个
     * 和真实原因毫无关系的错。
     */
    app.all('/api/*', (c) =>
      c.json({ error: 'not_found', message: `接口 ${c.req.path} 不存在` }, 404),
    )

    app.use('/*', serveStatic({ root }))
    // 直接敲根路径或任意路径时回 index.html
    app.get('*', serveStatic({ path: 'index.html', root }))
  }

  return app
}

/** 从 multipart/form-data 里读出所有图片。 */
async function readImages(request: Request): Promise<PageImage[]> {
  const form = await request.formData()
  const entries = form.getAll('pages').filter((value): value is File => value instanceof File)

  if (entries.length === 0) {
    throw new Error('没有收到图片。请用 multipart/form-data，字段名为 pages。')
  }
  if (entries.length > MAX_PAGES) {
    throw new Error(`一次最多 ${MAX_PAGES} 页，收到 ${entries.length} 页。`)
  }

  const images: PageImage[] = []
  for (const file of entries) {
    const mediaType = file.type === 'image/jpg' ? 'image/jpeg' : file.type
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      throw new Error(
        `不支持的图片类型「${file.type || '未知'}」。` +
          'HEIC 需要前端先转成 JPEG（上传页已经会自动转）。',
      )
    }
    if (file.size > MAX_BYTES_PER_PAGE) {
      throw new Error(
        `单页不能超过 ${MAX_BYTES_PER_PAGE / 1024 / 1024}MB，` +
          `${file.name || '这一页'} 有 ${(file.size / 1024 / 1024).toFixed(1)}MB。`,
      )
    }
    const bytes = Buffer.from(await file.arrayBuffer())
    images.push({ mediaType, base64: bytes.toString('base64') })
  }
  return images
}

/** 取客户端 IP 用于限频。反代后面看 x-forwarded-for 的第一段。 */
function clientIp(request: Request, forwardedFor: string | undefined): string {
  const first = forwardedFor?.split(',')[0]?.trim()
  if (first !== undefined && first !== '') return first
  // @hono/node-server 会把 Node 的 socket 信息挂在这里
  const address = (request as { socket?: { remoteAddress?: string } }).socket?.remoteAddress
  return address ?? 'unknown'
}
