import { serve } from '@hono/node-server'
import { findCjkFonts } from '@drill/export'
import {
  CachingTtsProvider,
  hasMacSay,
  MacSayTtsProvider,
  VolcanoTtsProvider,
  type TtsProvider,
} from '@drill/tts'
import { createProvider, describeConfig, loadAiConfig, MissingCredentialError } from '@drill/ai'
import { createApp } from './app.js'
import { resolve } from 'node:path'
import { rewriteLoopbackForContainer } from './containerEnv.js'
import { openDb } from './db/index.js'
import { ExportQueue } from './exportQueue.js'
import { RateLimiter } from './rateLimit.js'

/**
 * 容器里把指向回环地址的服务地址改写成 host.docker.internal。
 *
 * 这样一份 .env 本机跑和容器跑都不用改：`http://127.0.0.1:38080` 在本机
 * 就是本机，在容器里自动指向宿主机。外部地址不受影响，改了什么下面会打出来。
 */
const { env: runtimeEnv, rewrites } = rewriteLoopbackForContainer(process.env, [
  'AI_BASE_URL',
  'VOLCANO_TTS_BASE_URL',
])
// 同时写回 process.env：否则在容器里跑 pnpm probe 之类的脚本时，
// 它们读到的还是没改写过的回环地址，报「连不上」而看不出原因
for (const rewrite of rewrites) process.env[rewrite.key] = rewrite.to

let config
try {
  config = loadAiConfig(runtimeEnv)
} catch (error) {
  if (error instanceof MissingCredentialError) {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  }
  throw error
}

const limiter = new RateLimiter(
  Number.parseInt(process.env['RECOGNIZE_RATE_LIMIT_PER_HOUR'] ?? '20', 10),
)
// 定期清理过期的限频记录
setInterval(() => limiter.prune(), 10 * 60 * 1000).unref()

const dbPath = process.env['DB_PATH'] ?? 'data/drills.db'
const db = openDb(dbPath)

/**
 * 语音合成提供商。
 *
 * TTS_PROVIDER=mac-say 时用系统自带的合成器（仅 macOS，本地自测用，零成本）。
 * 不配置就没有配音能力：界面上仍可勾选，但会导出无声视频并说明原因。
 */
async function createTts(): Promise<{ provider?: TtsProvider; note: string }> {
  const kind = runtimeEnv['TTS_PROVIDER']
  if (kind === undefined || kind === 'none') return { note: '未配置（导出为无声视频）' }

  if (kind === 'volcano') {
    const speaker = runtimeEnv['TTS_VOICE']
    if (speaker === undefined || speaker.trim() === '') {
      return { note: '缺少 TTS_VOICE（发音人/音色名），已按未配置处理' }
    }
    try {
      const provider = new VolcanoTtsProvider({
        speaker,
        ...(runtimeEnv['VOLCANO_TTS_BASE_URL'] === undefined
          ? {}
          : { baseUrl: runtimeEnv['VOLCANO_TTS_BASE_URL'] }),
        ...(runtimeEnv['VOLCANO_TTS_TRANSPORT'] === undefined
          ? {}
          : { transport: runtimeEnv['VOLCANO_TTS_TRANSPORT'] as 'sse' | 'chunked' }),
        ...(runtimeEnv['VOLCANO_TTS_RESOURCE_ID'] === undefined
          ? {}
          : { resourceId: runtimeEnv['VOLCANO_TTS_RESOURCE_ID'] }),
        ...(runtimeEnv['VOLCANO_TTS_API_KEY'] === undefined
          ? {}
          : { apiKey: runtimeEnv['VOLCANO_TTS_API_KEY'] }),
        ...(runtimeEnv['VOLCANO_TTS_APP_ID'] === undefined
          ? {}
          : { appId: runtimeEnv['VOLCANO_TTS_APP_ID'] }),
        ...(runtimeEnv['VOLCANO_TTS_ACCESS_KEY'] === undefined
          ? {}
          : { accessKey: runtimeEnv['VOLCANO_TTS_ACCESS_KEY'] }),
        // 按字符计费，每次调用都记一笔（docs/spec.md 第 7 节）
        onUsage: ({ characters, text }) => {
          console.log(`[tts] 计费字符=${characters} 文本=「${text.slice(0, 30)}」`)
        },
      })
      const cacheDir = process.env['TTS_CACHE_DIR'] ?? 'data/tts-cache'
      return {
        provider: new CachingTtsProvider(provider, cacheDir),
        note: `火山引擎 ${runtimeEnv['VOLCANO_TTS_RESOURCE_ID'] ?? 'seed-tts-2.0'}，音色 ${speaker}（缓存目录 ${cacheDir}）`,
      }
    } catch (error) {
      return { note: `火山引擎配置有误：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  if (kind === 'mac-say') {
    if (!(await hasMacSay())) return { note: 'mac-say 不可用（本机没有 say 命令）' }
    const cacheDir = process.env['TTS_CACHE_DIR'] ?? 'data/tts-cache'
    return {
      provider: new CachingTtsProvider(new MacSayTtsProvider(), cacheDir),
      note: `mac-say（缓存目录 ${cacheDir}）`,
    }
  }

  return { note: `未知的 TTS_PROVIDER「${kind}」，已按未配置处理` }
}

const tts = await createTts()

const exportDir = process.env['EXPORT_DIR'] ?? 'data/exports'
const exportQueue = new ExportQueue({
  dir: exportDir,
  concurrency: Number.parseInt(process.env['EXPORT_CONCURRENCY'] ?? '1', 10),
  ...(process.env['FFMPEG_PATH'] === undefined ? {} : { ffmpegPath: process.env['FFMPEG_PATH'] }),
  ...(tts.provider === undefined ? {} : { tts: tts.provider }),
  ...(process.env['TTS_VOICE'] === undefined ? {} : { ttsVoice: process.env['TTS_VOICE'] }),
})
// 启动时清一次残留文件：上次进程被杀掉时可能留下半成品
void exportQueue.prune()

// 生产环境把前端构建产物一起托管，前后端同源、只开一个端口
const webDist = process.env['WEB_DIST']

const app = createApp({
  provider: createProvider(config),
  config,
  rateLimiter: limiter,
  db,
  exportQueue,
  ...(webDist === undefined ? {} : { webDist }),
})
const port = Number.parseInt(process.env['PORT'] ?? '8787', 10)

console.log('大模型配置：', JSON.stringify(describeConfig(config), null, 2))
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`\nAPI 已启动：http://localhost:${info.port}`)
  console.log(`健康检查：  http://localhost:${info.port}/api/health`)
  // 打印绝对路径：DB_PATH 是相对启动目录的，从不同目录起服务会落到不同文件
  console.log(`训练库：    ${resolve(dbPath)}`)
  console.log(`导出目录：  ${resolve(exportDir)}`)
  console.log(`配音：      ${tts.note}`)
  console.log(
    webDist === undefined
      ? '前端：      未托管（开发时用 pnpm dev，Vite 代理 /api）'
      : `前端：      ${resolve(webDist)}`,
  )
  console.log(`限频：      识别接口每 IP 每小时 ${process.env['RECOGNIZE_RATE_LIMIT_PER_HOUR'] ?? '20'} 次`)
  for (const rewrite of rewrites) {
    // 静默改写配置会让人对着一个「明明写对了」的地址查半天
    console.log(
      `↻ 容器内改写 ${rewrite.key}：${rewrite.from} → ${rewrite.to}` +
        '（容器里的 127.0.0.1 是容器自己；不想改写就设 DISABLE_LOOPBACK_REWRITE=1）',
    )
  }
  const fonts = findCjkFonts()
  console.log(
    fonts.length === 0
      ? '⚠ 没有中文字体，导出的说明文字会变方框'
      : `导出字体：  ${fonts.slice(0, 4).join('、')}${fonts.length > 4 ? ` 等 ${fonts.length} 种` : ''}`,
  )
})
