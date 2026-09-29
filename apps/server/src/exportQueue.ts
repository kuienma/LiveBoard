import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addNarration,
  buildNarrationCues,
  CancelledError,
  exportVideo,
  planVariants,
  type Orientation,
} from '@drill/export'
import type { Drill } from '@drill/schema'
import type { TtsProvider } from '@drill/tts'

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ExportTask {
  id: string
  title: string
  status: TaskStatus
  /** 已渲染帧数 / 总帧数。排队时 total 已知，done 为 0。 */
  done: number
  total: number
  createdAt: number
  finishedAt?: number
  /** 完成后的文件绝对路径。 */
  file?: string
  fileName?: string
  bytes?: number
  durationSeconds?: number
  message?: string
  /** 配音结果说明：没开、成功、或为什么没配上。 */
  narration?: string
}

export interface ExportRequest {
  drill: Drill
  title: string
  variantIds: string[]
  orientation: Orientation
  showNarration: boolean
  /** 是否加中文配音。没配置 TTS 时会降级成无声，并在 narration 里说明。 */
  voiceOver: boolean
}

export interface QueueOptions {
  dir: string
  /**
   * 同时渲染几个任务。默认 1：1080p 逐帧渲染是纯 CPU 活，
   * 并发只会让每个任务都变慢，还可能把内存顶上去。
   */
  concurrency?: number
  /** 排队上限，超了直接拒绝——比让用户等十分钟诚实。 */
  maxQueued?: number
  /** 文件保留时长，过期自动删除（毫秒）。 */
  keepMs?: number
  ffmpegPath?: string
  /** 配音提供商。不传就等于没开配音能力。 */
  tts?: TtsProvider
  ttsVoice?: string
}

export class QueueFullError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueFullError'
  }
}

/**
 * 视频导出任务队列。
 *
 * 任务本身只放内存：进程重启后未完成的任务没有意义，而已完成的文件还在磁盘上，
 * 用户重新点一次导出的成本远低于为它建一张表。
 */
export class ExportQueue {
  private readonly tasks = new Map<string, ExportTask>()
  private readonly pending: Array<{ task: ExportTask; request: ExportRequest }> = []
  private readonly cancelling = new Set<string>()
  private running = 0

  constructor(private readonly options: QueueOptions) {}

  private get concurrency(): number {
    return this.options.concurrency ?? 1
  }

  private get maxQueued(): number {
    return this.options.maxQueued ?? 8
  }

  private get keepMs(): number {
    return this.options.keepMs ?? 60 * 60 * 1000
  }

  /** 服务端有没有配置语音合成。 */
  canNarrate(): boolean {
    return this.options.tts !== undefined
  }

  list(): ExportTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): ExportTask | undefined {
    return this.tasks.get(id)
  }

  /** 排队一个导出任务。总帧数在这里就算出来，进度条从一开始就有分母。 */
  enqueue(request: ExportRequest, totalFrames: number): ExportTask {
    if (this.pending.length >= this.maxQueued) {
      throw new QueueFullError(`导出队列已满（${this.maxQueued} 个等待中），请稍后再试`)
    }

    const task: ExportTask = {
      id: crypto.randomUUID(),
      title: request.title,
      status: 'queued',
      done: 0,
      total: totalFrames,
      createdAt: Date.now(),
    }
    this.tasks.set(task.id, task)
    this.pending.push({ task, request })
    void this.pump()
    return task
  }

  /** 取消排队中或正在跑的任务。 */
  cancel(id: string): boolean {
    const task = this.tasks.get(id)
    if (task === undefined) return false
    if (task.status === 'done' || task.status === 'failed') return false

    const queuedIndex = this.pending.findIndex((item) => item.task.id === id)
    if (queuedIndex !== -1) {
      this.pending.splice(queuedIndex, 1)
      task.status = 'cancelled'
      task.finishedAt = Date.now()
      return true
    }

    // 正在渲染：做个标记，渲染循环每帧会检查
    this.cancelling.add(id)
    return true
  }

  private async pump(): Promise<void> {
    if (this.running >= this.concurrency) return
    const next = this.pending.shift()
    if (next === undefined) return

    this.running++
    try {
      await this.run(next.task, next.request)
    } finally {
      this.running--
      void this.pump()
    }
  }

  private async run(task: ExportTask, request: ExportRequest): Promise<void> {
    task.status = 'running'
    try {
      await mkdir(this.options.dir, { recursive: true })
      await this.prune()

      const fileName = `${safeName(request.title)}-${request.orientation}.mp4`
      const path = join(this.options.dir, `${task.id}.mp4`)

      // 配音要在完整视频上混，所以先渲染到临时文件
      const silentPath = request.voiceOver ? `${path}.silent.mp4` : path

      const result = await exportVideo(request.drill, silentPath, {
        orientation: request.orientation,
        variantIds: request.variantIds,
        showNarration: request.showNarration,
        ...(this.options.ffmpegPath === undefined ? {} : { ffmpegPath: this.options.ffmpegPath }),
        onProgress: ({ done }) => {
          task.done = done
        },
        shouldCancel: () => this.cancelling.has(task.id),
      })

      task.narration = await this.narrate(request, silentPath, path)

      task.status = 'done'
      task.file = path
      task.fileName = fileName
      task.bytes = (await stat(path)).size
      task.durationSeconds = result.durationSeconds
      task.done = result.frames
      task.total = result.frames
    } catch (error) {
      if (error instanceof CancelledError) {
        task.status = 'cancelled'
        await rm(join(this.options.dir, `${task.id}.mp4`), { force: true })
        await rm(join(this.options.dir, `${task.id}.mp4.silent.mp4`), { force: true })
      } else {
        task.status = 'failed'
        task.message = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.cancelling.delete(task.id)
      task.finishedAt = Date.now()
    }
  }

  /**
   * 给已渲染好的视频加配音。
   *
   * 刻意做成「失败不影响导出」：配音是加分项，没配上也该给用户一个能用的视频，
   * 而不是把整个导出判失败——渲染那几百帧的算力不该因为一次接口超时白烧。
   */
  private async narrate(
    request: ExportRequest,
    silentPath: string,
    outPath: string,
  ): Promise<string> {
    if (!request.voiceOver) return '未开启配音'
    if (this.options.tts === undefined) {
      await rename(silentPath, outPath)
      return '服务端未配置语音合成，已导出无声视频'
    }

    try {
      const cues = buildNarrationCues(planVariants(request.drill, request.variantIds))
      if (cues.length === 0) {
        await rename(silentPath, outPath)
        return '没有可配音的说明文字，已导出无声视频'
      }

      const result = await addNarration(silentPath, outPath, cues, {
        provider: this.options.tts,
        ...(this.options.ttsVoice === undefined ? {} : { voice: this.options.ttsVoice }),
        ...(this.options.ffmpegPath === undefined ? {} : { ffmpegPath: this.options.ffmpegPath }),
      })
      await rm(silentPath, { force: true })
      return result.spedUp === 0
        ? `已配音 ${result.cues} 句`
        : `已配音 ${result.cues} 句，其中 ${result.spedUp} 句因时间不够略微提速`
    } catch (error) {
      // 混音失败就退回无声视频，并把原因说清楚
      await rename(silentPath, outPath).catch(() => undefined)
      return `配音失败，已导出无声视频：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** 删掉过期文件和对应的任务记录。 */
  async prune(now = Date.now()): Promise<void> {
    for (const [id, task] of this.tasks) {
      if (task.finishedAt !== undefined && now - task.finishedAt > this.keepMs) {
        this.tasks.delete(id)
      }
    }

    const files = await readdir(this.options.dir).catch(() => [])
    for (const name of files) {
      const path = join(this.options.dir, name)
      const info = await stat(path).catch(() => undefined)
      if (info !== undefined && now - info.mtimeMs > this.keepMs) {
        await rm(path, { force: true })
      }
    }
  }
}

/** 文件名里去掉路径分隔符等危险字符，标题是用户输入的。 */
function safeName(title: string): string {
  const cleaned = title.replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '').trim()
  return cleaned === '' ? '训练' : cleaned.slice(0, 40)
}
