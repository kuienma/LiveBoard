import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { Writable } from 'node:stream'
import type { Drill } from '@drill/schema'
import {
  createRenderer,
  EXPORT_FPS,
  EXPORT_SIZES,
  planVariants,
  type Orientation,
} from './frames.js'

export interface VideoOptions {
  orientation: Orientation
  /** 要导出的练法，按数组顺序拼进同一个文件。 */
  variantIds: readonly string[]
  showNarration?: boolean
  /**
   * 是否在角上标练法名。默认只在导出多个练法时标——
   * 单个练法时画面应该和播放器逐像素一致。
   */
  showVariantLabel?: boolean
  /** ffmpeg 可执行文件，默认走 PATH。 */
  ffmpegPath?: string
  onProgress?: (progress: { done: number; total: number }) => void
  /** 取消用：每帧检查一次，返回 true 就中止并删掉半成品。 */
  shouldCancel?: () => boolean
}

export interface VideoResult {
  path: string
  width: number
  height: number
  fps: number
  frames: number
  durationSeconds: number
}

export class CancelledError extends Error {
  constructor() {
    super('导出已取消')
    this.name = 'CancelledError'
  }
}

/**
 * 逐帧渲染并用 ffmpeg 合成 H.264 MP4。
 *
 * 帧以裸 RGBA 从 stdin 喂进 ffmpeg，不落中间 PNG：
 * 一个 1080p、10 秒的导出是 300 帧、约 2.5GB 的中间文件，磁盘上走一趟毫无必要。
 */
export async function exportVideo(
  drill: Drill,
  outPath: string,
  options: VideoOptions,
): Promise<VideoResult> {
  if (options.variantIds.length === 0) throw new Error('至少要选一个练法')

  const plans = planVariants(drill, options.variantIds)
  const total = plans.reduce((sum, plan) => sum + plan.frameCount, 0)
  const { width, height } = EXPORT_SIZES[options.orientation]
  const renderer = createRenderer(options.orientation)
  const labelEveryVariant = options.showVariantLabel ?? plans.length > 1

  const ffmpeg = spawn(options.ffmpegPath ?? 'ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    String(EXPORT_FPS),
    '-i',
    'pipe:0',
    '-an',
    '-c:v',
    'libx264',
    // yuv420p + faststart：手机相册、微信和剪映都认这个组合
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    '-y',
    outPath,
  ])

  const stderr: string[] = []
  ffmpeg.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))

  // spawn 失败（没装 ffmpeg）是 error 事件而不是抛异常，得单独接
  const failure = new Promise<never>((_resolve, reject) => {
    ffmpeg.once('error', (cause: NodeJS.ErrnoException) => {
      reject(
        cause.code === 'ENOENT'
          ? new Error('找不到 ffmpeg，无法导出视频。请先安装 ffmpeg 或设置 FFMPEG_PATH。')
          : cause,
      )
    })
  })
  // race 里只有一方会被消费，另一方会变成「无人接管的拒绝」；
  // 挂一个空 handler 让它算已处理，race 仍然能看到拒绝
  failure.catch(() => undefined)

  // 手写而不用 events.once：once 在 emitter 触发 error 时也会拒绝，
  // 于是没装 ffmpeg 时这里又多出一个无人接管的拒绝
  const exited = new Promise<number | null>((resolve) => {
    ffmpeg.once('close', (code) => resolve(code))
  })

  try {
    let done = 0
    for (const plan of plans) {
      for (let index = 0; index < plan.frameCount; index++) {
        if (options.shouldCancel?.() === true) throw new CancelledError()

        renderer.draw(plan, index, {
          orientation: options.orientation,
          ...(options.showNarration === undefined ? {} : { showNarration: options.showNarration }),
          ...(labelEveryVariant ? { variantLabel: plan.name } : {}),
        })

        await Promise.race([write(ffmpeg.stdin, renderer.canvas.data()), failure])

        done++
        options.onProgress?.({ done, total })
      }
    }

    ffmpeg.stdin.end()
    const code = await Promise.race([exited, failure])
    if (code !== 0) {
      throw new Error(`ffmpeg 退出码 ${String(code)}：${stderr.join('').trim().slice(0, 500)}`)
    }

    return {
      path: outPath,
      width,
      height,
      fps: EXPORT_FPS,
      frames: total,
      durationSeconds: Number((total / EXPORT_FPS).toFixed(2)),
    }
  } catch (cause) {
    ffmpeg.stdin.destroy()
    ffmpeg.kill('SIGKILL')
    throw cause
  }
}

/** 写一帧并遵守背压：不等 drain 会让内存被几百帧 RGBA 顶爆。 */
async function write(stream: Writable, chunk: Buffer | Uint8Array): Promise<void> {
  if (stream.write(chunk)) return
  await once(stream, 'drain')
}
