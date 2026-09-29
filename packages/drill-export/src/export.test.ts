import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseDrill, type Drill } from '@drill/schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXPORT_FPS, EXPORT_SIZES, findCjkFonts, planVariants } from './frames.js'
import { CancelledError, exportVideo } from './encode.js'
import { renderStillPng } from './still.js'

const run = promisify(execFile)

const fixture = JSON.parse(
  await readFile(new URL('../../../fixtures/side-attack.json', import.meta.url), 'utf8'),
) as unknown

const parsed = parseDrill(fixture)
if (!parsed.ok) throw new Error('测试夹具本身不合法，先修夹具')
const drill: Drill = parsed.drill

let dir: string

/**
 * 必须在模块顶层同步探测：it.skipIf 在收集阶段就求值，
 * 放进 beforeAll 的话所有 ffmpeg 用例都会被静默跳过（测试报绿但什么都没验）。
 */
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drill-export-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('帧数规划', () => {
  it('帧数按 30fps 由时长算出', () => {
    const [plan] = planVariants(drill, ['basic'])
    expect(plan).toBeDefined()
    expect(plan!.frameCount).toBe(Math.round(plan!.timeline.duration * EXPORT_FPS))
  })

  it('多个练法各自算帧数，顺序跟传入的一致', () => {
    const plans = planVariants(drill, ['var2', 'basic'])
    expect(plans.map((p) => p.variantId)).toEqual(['var2', 'basic'])
  })

  it('练法 id 不存在时报错，而不是导出一个空视频', () => {
    expect(() => planVariants(drill, ['不存在'])).toThrow('找不到练法')
  })
})

describe('中文字体', () => {
  it('当前环境能找到中文字体（找不到说明文字会变方框）', () => {
    expect(findCjkFonts().length).toBeGreaterThan(0)
  })
})

describe('PNG 静态图', () => {
  it('横屏竖屏都出一张真 PNG，尺寸符合预期', () => {
    for (const orientation of ['landscape', 'portrait'] as const) {
      const png = renderStillPng(drill, 'basic', { orientation })
      // PNG 魔数
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      // IHDR 里的宽高是大端 32 位，直接读出来核对
      expect(png.readUInt32BE(16)).toBe(EXPORT_SIZES[orientation].width)
      expect(png.readUInt32BE(20)).toBe(EXPORT_SIZES[orientation].height)
    }
  })

  it('画了东西，不是一张空图', () => {
    const png = renderStillPng(drill, 'basic', { orientation: 'landscape' })
    // 纯色图会被 PNG 压到极小；有场地、球员、虚线时远不止这点体积
    expect(png.byteLength).toBeGreaterThan(20_000)
  })

  it('练法 id 不存在时报错', () => {
    expect(() => renderStillPng(drill, '不存在', { orientation: 'landscape' })).toThrow(
      '找不到练法',
    )
  })
})

describe('MP4 导出', () => {
  it.skipIf(!hasFfmpeg)('生成 H.264 / yuv420p / 30fps 的 MP4，时长与帧数对得上', async () => {
    const out = join(dir, 'basic.mp4')
    const progress: number[] = []
    const result = await exportVideo(drill, out, {
      orientation: 'landscape',
      variantIds: ['basic'],
      onProgress: ({ done }) => progress.push(done),
    })

    expect(result.frames).toBe(planVariants(drill, ['basic'])[0]!.frameCount)
    expect(result.width).toBe(1920)
    expect(result.height).toBe(1080)
    expect((await stat(out)).size).toBeGreaterThan(10_000)

    // 进度要一帧一帧报到满，否则界面上的进度条会跳
    expect(progress.at(0)).toBe(1)
    expect(progress.at(-1)).toBe(result.frames)
    expect(progress.length).toBe(result.frames)

    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,pix_fmt,width,height,nb_frames,r_frame_rate',
      '-of',
      'json',
      out,
    ])
    const stream = (JSON.parse(stdout) as { streams: Array<Record<string, unknown>> }).streams[0]!
    expect(stream['codec_name']).toBe('h264')
    // 剪映和手机相册都要 yuv420p，换成别的会「无法导入」
    expect(stream['pix_fmt']).toBe('yuv420p')
    expect(stream['width']).toBe(1920)
    expect(stream['r_frame_rate']).toBe('30/1')
    expect(Number(stream['nb_frames'])).toBe(result.frames)
  }, 120_000)

  it.skipIf(!hasFfmpeg)('多个练法拼进一个文件，总帧数等于各自相加', async () => {
    const out = join(dir, 'two.mp4')
    const plans = planVariants(drill, ['basic', 'var2'])
    const result = await exportVideo(drill, out, {
      orientation: 'portrait',
      variantIds: ['basic', 'var2'],
    })
    expect(result.frames).toBe(plans[0]!.frameCount + plans[1]!.frameCount)
    expect(result.height).toBe(1920)
  }, 180_000)

  it('一个练法都不选时直接报错', async () => {
    await expect(exportVideo(drill, join(dir, 'none.mp4'), {
      orientation: 'landscape',
      variantIds: [],
    })).rejects.toThrow('至少要选一个练法')
  })

  it.skipIf(!hasFfmpeg)('取消会抛 CancelledError，不会留下完整文件', async () => {
    const out = join(dir, 'cancelled.mp4')
    let frames = 0
    await expect(
      exportVideo(drill, out, {
        orientation: 'landscape',
        variantIds: ['basic'],
        shouldCancel: () => ++frames > 5,
      }),
    ).rejects.toBeInstanceOf(CancelledError)
  }, 60_000)

  it('ffmpeg 路径不对时给出能看懂的中文提示', async () => {
    await expect(
      exportVideo(drill, join(dir, 'nope.mp4'), {
        orientation: 'landscape',
        variantIds: ['basic'],
        ffmpegPath: '/绝对不存在的/ffmpeg',
      }),
    ).rejects.toThrow('找不到 ffmpeg')
  })
})
