import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseDrill, type Drill } from '@drill/schema'
import type { TtsAudio, TtsProvider, TtsRequest } from '@drill/tts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportVideo } from './encode.js'
import { planVariants } from './frames.js'
import { addNarration, buildNarrationCues } from './narration.js'

const run = promisify(execFile)
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const parsed = parseDrill(
  JSON.parse(
    await readFile(new URL('../../../fixtures/side-attack.json', import.meta.url), 'utf8'),
  ) as unknown,
)
if (!parsed.ok) throw new Error('测试夹具本身不合法')
const drill: Drill = parsed.drill

/**
 * 假提供商：按字数生成一段正弦波 WAV。
 *
 * 不用 macOS 的 say：测试不该依赖某个操作系统的语音包，
 * 而且自己造音频才能精确控制时长，从而验证「念不完就提速」这条分支。
 */
class FakeTts implements TtsProvider {
  readonly kind = 'fake'
  readonly defaultVoice = 'test'
  readonly calls: TtsRequest[] = []

  constructor(private readonly secondsPerChar = 0.2) {}

  synthesize(request: TtsRequest): Promise<TtsAudio> {
    this.calls.push(request)
    const seconds = Math.max(0.1, request.text.length * this.secondsPerChar)
    return Promise.resolve({ data: sineWav(seconds), format: 'wav' })
  }
}

/** 造一段 8kHz 单声道 16bit 的正弦波 WAV。 */
function sineWav(seconds: number, rate = 8000): Buffer {
  const samples = Math.round(seconds * rate)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'narration-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('buildNarrationCues', () => {
  it('内容每轮都变时一轮一句，落在该轮开始的时刻', () => {
    // 变化二有 swap，来向和转身方向逐轮交替，每轮说明文字确实不同
    const plans = planVariants(drill, ['var2'])
    const cues = buildNarrationCues(plans)
    const rounds = plans[0]!.timeline.rounds

    expect(cues).toHaveLength(rounds.length)
    for (const [index, cue] of cues.entries()) {
      expect(cue.at).toBeCloseTo(rounds[index]!.startTime, 6)
      expect(cue.text).toContain(`第 ${index + 1} 次`)
    }
  })

  it('每轮内容一样时只念一次——三遍「第 N 次：同一句话」是噪音', () => {
    const plans = planVariants(drill, ['basic'])
    const rounds = plans[0]!.timeline.rounds
    // 前提：基本练法各轮只差「第几次」
    expect(rounds.length).toBeGreaterThan(1)
    const cores = rounds.map((round) => round.narration.replace(/^第\s*\d+\s*次：/, ''))
    expect(new Set(cores).size).toBe(1)

    const cues = buildNarrationCues(plans)
    expect(cues).toHaveLength(1)
    expect(cues[0]!.at).toBe(0)
    // 唯一那句的窗口覆盖整个练法，不会被后面不存在的句子截断
    expect(cues[0]!.window).toBeCloseTo(plans[0]!.frameCount / 30, 6)
  })

  it('内容变了又变回来时照旧念（只跟上一句比，不做全局去重）', () => {
    const plans = planVariants(drill, ['var2'])
    const cues = buildNarrationCues(plans)
    // 左右交替：第 3 轮和第 1 轮内容相同，但和第 2 轮不同，所以要念
    expect(cues.length).toBe(plans[0]!.timeline.rounds.length)
  })

  it('window 是到下一句的间隔，最后一句到视频结束', () => {
    const plans = planVariants(drill, ['var2'])
    const cues = buildNarrationCues(plans)
    for (const [index, cue] of cues.entries()) {
      const next = cues[index + 1]
      if (next !== undefined) expect(cue.window).toBeCloseTo(next.at - cue.at, 6)
    }
    const total = plans[0]!.frameCount / 30
    const last = cues.at(-1)!
    expect(last.at + last.window).toBeCloseTo(total, 6)
  })

  it('多个练法：时间按前面练法的长度累加，且第一句报出练法名', () => {
    const plans = planVariants(drill, ['basic', 'var2'])
    const cues = buildNarrationCues(plans)
    const firstDuration = plans[0]!.frameCount / 30

    const secondVariant = cues.filter((cue) => cue.at >= firstDuration - 1e-6)
    expect(secondVariant.length).toBeGreaterThan(0)
    expect(secondVariant[0]!.at).toBeCloseTo(firstDuration, 6)
    // 换练法要报名字，否则观众不知道画面为什么变了
    expect(secondVariant[0]!.text.startsWith(plans[1]!.name)).toBe(true)
    // 单个练法时不加前缀
    expect(buildNarrationCues([plans[0]!])[0]!.text.startsWith(plans[0]!.name)).toBe(false)
  })
})

describe('addNarration', () => {
  it('没有可配音的文字时直接报错', async () => {
    await expect(
      addNarration('x.mp4', 'y.mp4', [], { provider: new FakeTts() }),
    ).rejects.toThrow('没有可配音的说明文字')
  })

  it.skipIf(!hasFfmpeg)('混出带 aac 音轨的视频，画面时长不变', async () => {
    const silent = join(dir, 'silent.mp4')
    await exportVideo(drill, silent, { orientation: 'landscape', variantIds: ['basic'] })

    const plans = planVariants(drill, ['basic'])
    const cues = buildNarrationCues(plans)
    const out = join(dir, 'narrated.mp4')
    const tts = new FakeTts()
    const result = await addNarration(silent, out, cues, { provider: tts })

    expect(result.cues).toBe(cues.length)
    expect(tts.calls).toHaveLength(cues.length)

    const streams = await probe(out, 'stream=codec_type,codec_name')
    expect(streams).toContain('aac')
    expect(streams).toContain('h264')

    // 画面不能被配音截断，也不该被重新编码
    const before = Number(await probe(silent, 'format=duration'))
    const after = Number(await probe(out, 'format=duration'))
    expect(after).toBeCloseTo(before, 1)
  }, 180_000)

  it.skipIf(!hasFfmpeg)('配音落在计划的时刻上（用静音检测验证）', async () => {
    const silent = join(dir, 'silent2.mp4')
    await exportVideo(drill, silent, { orientation: 'landscape', variantIds: ['basic'] })

    const cues = buildNarrationCues(planVariants(drill, ['basic']))
    const out = join(dir, 'narrated2.mp4')
    // 每句都远短于可用窗口，句子之间必定有静音
    await addNarration(silent, out, cues, { provider: new FakeTts(0.05) })

    const { stderr } = await run('ffmpeg', [
      '-hide_banner',
      '-i',
      out,
      '-af',
      'silencedetect=noise=-40dB:d=0.3',
      '-f',
      'null',
      '-',
    ])
    const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((match) =>
      Number(match[1]),
    )
    // 第二、第三句的起点应该正好是两段静音的结束处
    for (const cue of cues.slice(1)) {
      expect(ends.some((end) => Math.abs(end - cue.at) < 0.15)).toBe(true)
    }
  }, 180_000)

  it.skipIf(!hasFfmpeg)('念不完的句子会被提速，而不是盖住下一句', async () => {
    const silent = join(dir, 'silent3.mp4')
    await exportVideo(drill, silent, { orientation: 'landscape', variantIds: ['basic'] })

    const cues = buildNarrationCues(planVariants(drill, ['basic']))
    // 每字 1 秒，19 个字远超 5.7 秒的窗口
    const result = await addNarration(silent, join(dir, 'narrated3.mp4'), cues, {
      provider: new FakeTts(1),
    })
    expect(result.spedUp).toBe(cues.length)
  }, 180_000)
})

async function probe(path: string, entries: string): Promise<string> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    entries,
    '-of',
    'default=nw=1:nk=1',
    path,
  ])
  return stdout
}
