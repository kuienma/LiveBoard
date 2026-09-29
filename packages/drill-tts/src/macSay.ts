import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { TtsError, type TtsAudio, type TtsProvider, type TtsRequest } from './types.js'

const run = promisify(execFile)

/**
 * macOS 自带的 say 命令。
 *
 * 只用于本地开发和自测：零成本、文字不出网，能把「时间轴对不对、混音对不对」
 * 这些问题先在本机验完，不必为了调通管道反复调用云端接口付费。
 * 线上环境（Linux 容器）没有 say，要用云端提供商。
 */
export class MacSayTtsProvider implements TtsProvider {
  readonly kind = 'mac-say'
  readonly defaultVoice = 'Tingting'

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const dir = await mkdtemp(join(tmpdir(), 'say-'))
    const out = join(dir, 'out.aiff')
    try {
      // say 的语速是「每分钟词数」，中文按字算，180 大致相当于正常语速
      const rate = Math.round(180 * (request.speed ?? 1))
      await run('say', [
        '-v',
        request.voice ?? this.defaultVoice,
        '-r',
        String(rate),
        '-o',
        out,
        request.text,
      ])
      return { data: await readFile(out), format: 'aiff' }
    } catch (cause) {
      throw new TtsError(
        `本机 say 合成失败：${cause instanceof Error ? cause.message : String(cause)}`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

/** 当前机器能不能用 say（只有 macOS 有，且要装了对应语音）。 */
export async function hasMacSay(): Promise<boolean> {
  return run('say', ['-v', '?']).then(
    () => true,
    () => false,
  )
}
