import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TtsProvider } from '@drill/tts'
import { EXPORT_FPS, type VariantPlan } from './frames.js'

const run = promisify(execFile)

/** 一句配音：在视频的第几秒开始，说什么。 */
export interface NarrationCue {
  /** 视频时间轴上的起始秒数。 */
  at: number
  text: string
  /** 到下一句之前可用的秒数；用来判断要不要提速。 */
  window: number
}

/**
 * 从要导出的练法列出配音句子。
 *
 * 一轮一句：说明文字本来就是按轮变的（「第 2 次：防守者从左边来…」），
 * 按阶段念会把一句话切碎，按整个练法念又跟不上画面。
 *
 * 内容重复的轮次不再念：基本练法每轮完全一样，说明文字只差「第几次」，
 * 连念三遍「第 N 次：防守者从右边来，运球员向左转身」是纯噪音。
 * 有 swap / rotate 的变化练法每轮内容真的不同，才会每轮都念。
 *
 * 多个练法拼一个视频时，第一句前面加上练法名，观众才知道换练法了。
 */
export function buildNarrationCues(plans: readonly VariantPlan[]): NarrationCue[] {
  const cues: Array<{ at: number; text: string }> = []
  let offset = 0

  for (const plan of plans) {
    const multiple = plans.length > 1
    /** 上一句念过的内容（已去掉轮次前缀），用来判断这一轮要不要念。 */
    let spokenCore: string | undefined

    for (const [index, round] of plan.timeline.rounds.entries()) {
      const text = round.narration.trim()
      if (text === '') continue

      const core = narrationCore(text)
      if (index > 0 && core === spokenCore) continue
      spokenCore = core

      // 练法名只在该练法第一轮报一次
      const prefix = multiple && index === 0 ? `${plan.name}。` : ''
      cues.push({ at: offset + round.startTime, text: `${prefix}${text}` })
    }
    // 帧数才是视频里真实的长度（时长按 30fps 取整过）
    offset += plan.frameCount / EXPORT_FPS
  }

  return cues.map((cue, index) => ({
    ...cue,
    window: (cues[index + 1]?.at ?? offset) - cue.at,
  }))
}

/**
 * 去掉「第 N 次」这个轮次前缀，只留下真正的内容。
 *
 * 引擎生成的格式是「第 N 次：内容」（单轮时没有前缀）。
 * 判重必须按内容，否则每轮都因为编号不同而被当成新句子。
 */
function narrationCore(text: string): string {
  return text.replace(/^第\s*\d+\s*次(：|:)?\s*/, '')
}

export interface NarrationResult {
  /** 混好音的视频路径。 */
  path: string
  cues: number
  /** 因为时间不够而被提速的句子数。 */
  spedUp: number
}

export interface NarrationOptions {
  provider: TtsProvider
  voice?: string
  speed?: number
  ffmpegPath?: string
  onProgress?: (progress: { done: number; total: number }) => void
}

/**
 * 合成每句配音并混进视频。
 *
 * 做法是把每段音频用 adelay 推到它该出现的时刻，再 amix 成一条音轨。
 * 视频流直接 copy，不重新编码——画面已经渲染好了，重编一遍只会掉质量、费时间。
 */
export async function addNarration(
  videoPath: string,
  outPath: string,
  cues: readonly NarrationCue[],
  options: NarrationOptions,
): Promise<NarrationResult> {
  if (cues.length === 0) throw new Error('没有可配音的说明文字')

  const ffmpeg = options.ffmpegPath ?? 'ffmpeg'
  const dir = await mkdtemp(join(tmpdir(), 'drill-narration-'))
  let spedUp = 0

  try {
    const clips: Array<{ path: string; at: number; tempo: number }> = []

    for (const [index, cue] of cues.entries()) {
      const audio = await options.provider.synthesize({
        text: cue.text,
        ...(options.voice === undefined ? {} : { voice: options.voice }),
        ...(options.speed === undefined ? {} : { speed: options.speed }),
      })
      const path = join(dir, `${index}.${audio.format}`)
      await writeFile(path, audio.data)

      // 念不完就轻微提速，而不是让两句话叠在一起
      const duration = await probeDuration(path, options.ffmpegPath)
      const tempo = clampTempo(duration, cue.window)
      if (tempo > 1) spedUp++

      clips.push({ path, at: cue.at, tempo })
      options.onProgress?.({ done: index + 1, total: cues.length })
    }

    await mux(ffmpeg, videoPath, clips, outPath)
    return { path: outPath, cues: cues.length, spedUp }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 提速倍率。
 *
 * 上限 1.4：再快中文就开始听不清了。超过还念不完就让它盖到下一句上——
 * 丢掉一句说明比让它变成快进磁带更糟。
 */
const MAX_TEMPO = 1.4

function clampTempo(duration: number, window: number): number {
  if (window <= 0 || duration <= window) return 1
  return Math.min(duration / window, MAX_TEMPO)
}

async function probeDuration(path: string, ffmpegPath?: string): Promise<number> {
  // ffprobe 和 ffmpeg 是一起装的，按同目录推断
  const probe = ffmpegPath === undefined ? 'ffprobe' : ffmpegPath.replace(/ffmpeg$/, 'ffprobe')
  const { stdout } = await run(probe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    path,
  ])
  const seconds = Number.parseFloat(stdout.trim())
  return Number.isFinite(seconds) ? seconds : 0
}

async function mux(
  ffmpegPath: string,
  videoPath: string,
  clips: ReadonlyArray<{ path: string; at: number; tempo: number }>,
  outPath: string,
): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', videoPath]
  for (const clip of clips) args.push('-i', clip.path)

  const filters = clips.map((clip, index) => {
    const delayMs = Math.round(clip.at * 1000)
    // 统一成单声道 44.1k 再混：各提供商返回的采样率不一样，不统一 amix 会报错
    const tempo = clip.tempo > 1 ? `,atempo=${clip.tempo.toFixed(3)}` : ''
    return `[${index + 1}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono${tempo},adelay=${delayMs}[a${index}]`
  })
  const mixInputs = clips.map((_clip, index) => `[a${index}]`).join('')
  // normalize=0：默认会按输入路数整体压低音量，句子越多声音越小
  filters.push(`${mixInputs}amix=inputs=${clips.length}:normalize=0[aout]`)

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    // 不加 -shortest：画面必须完整播完，哪怕配音先结束
    '-movflags',
    '+faststart',
    '-y',
    outPath,
  )

  const child = spawn(ffmpegPath, args)
  const stderr: string[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', (cause: NodeJS.ErrnoException) => {
      reject(
        cause.code === 'ENOENT'
          ? new Error('找不到 ffmpeg，无法混入配音。')
          : cause,
      )
    })
    child.once('close', resolve)
  })

  if (code !== 0) {
    throw new Error(`混音失败（ffmpeg 退出码 ${String(code)}）：${stderr.join('').trim().slice(0, 400)}`)
  }
}
