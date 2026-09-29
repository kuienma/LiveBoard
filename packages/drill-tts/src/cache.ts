import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TtsAudio, TtsProvider, TtsRequest } from './types.js'

/**
 * 按内容缓存合成结果。
 *
 * 云端合成按字符计费，而同一个训练反复导出（改了画面、换了横竖屏）时
 * 说明文字一个字都没变。不缓存就是每次都重新付一遍钱。
 *
 * key 包含提供商、发音人、语速和文字：换发音人要重新合成，改文字当然也要。
 */
export class CachingTtsProvider implements TtsProvider {
  readonly kind: string
  readonly defaultVoice: string

  constructor(
    private readonly inner: TtsProvider,
    private readonly dir: string,
    /** 缓存保留时长（毫秒），默认 30 天。 */
    private readonly keepMs = 30 * 24 * 60 * 60 * 1000,
  ) {
    this.kind = inner.kind
    this.defaultVoice = inner.defaultVoice
  }

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const voice = request.voice ?? this.defaultVoice
    const speed = request.speed ?? 1
    const key = createHash('sha256')
      .update(`${this.kind}\u0000${voice}\u0000${String(speed)}\u0000${request.text}`)
      .digest('hex')
      .slice(0, 32)

    await mkdir(this.dir, { recursive: true })

    // 命中就直接返回。扩展名存在文件名里，省一份元数据文件
    for (const format of ['mp3', 'wav', 'aiff'] as const) {
      const path = join(this.dir, `${key}.${format}`)
      const data = await readFile(path).catch(() => undefined)
      if (data !== undefined) return { data, format }
    }

    const audio = await this.inner.synthesize(request)
    await writeFile(join(this.dir, `${key}.${audio.format}`), audio.data)
    return audio
  }

  /** 删掉太久没用到的缓存。 */
  async prune(now = Date.now()): Promise<number> {
    const names = await readdir(this.dir).catch(() => [])
    let removed = 0
    for (const name of names) {
      const path = join(this.dir, name)
      const info = await stat(path).catch(() => undefined)
      if (info !== undefined && now - info.mtimeMs > this.keepMs) {
        await rm(path, { force: true })
        removed++
      }
    }
    return removed
  }
}
