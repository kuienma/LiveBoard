import { describe, expect, it } from 'vitest'
import { isInContainer, rewriteLoopbackForContainer } from './containerEnv.js'

/** 造一个「容器内」的 env。 */
const inContainer = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  IN_CONTAINER: '1',
  ...extra,
})

const KEYS = ['AI_BASE_URL', 'VOLCANO_TTS_BASE_URL'] as const

describe('isInContainer', () => {
  it('镜像里显式设了 IN_CONTAINER=1 就算容器内', () => {
    expect(isInContainer({ IN_CONTAINER: '1' })).toBe(true)
  })

  it('本机开发（没有这个变量、也没有 /.dockerenv）不算', () => {
    expect(isInContainer({})).toBe(false)
  })
})

describe('容器内改写回环地址', () => {
  it('127.0.0.1 改成 host.docker.internal，端口保留', () => {
    const { env, rewrites } = rewriteLoopbackForContainer(
      inContainer({ AI_BASE_URL: 'http://127.0.0.1:38080' }),
      KEYS,
    )
    expect(env['AI_BASE_URL']).toBe('http://host.docker.internal:38080')
    expect(rewrites).toEqual([
      { key: 'AI_BASE_URL', from: 'http://127.0.0.1:38080', to: 'http://host.docker.internal:38080' },
    ])
  })

  it('localhost 同样改写', () => {
    const { env } = rewriteLoopbackForContainer(
      inContainer({ AI_BASE_URL: 'http://localhost:11434/v1' }),
      KEYS,
    )
    expect(env['AI_BASE_URL']).toBe('http://host.docker.internal:11434/v1')
  })

  it('路径和查询串原样保留，只换主机名', () => {
    const { env } = rewriteLoopbackForContainer(
      inContainer({ AI_BASE_URL: 'http://127.0.0.1:8080/gateway/v1?x=1' }),
      KEYS,
    )
    expect(env['AI_BASE_URL']).toBe('http://host.docker.internal:8080/gateway/v1?x=1')
  })

  it('外部地址一律不动——这是最要紧的一条', () => {
    const outside = {
      AI_BASE_URL: 'https://api.anthropic.com',
      VOLCANO_TTS_BASE_URL: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    }
    const { env, rewrites } = rewriteLoopbackForContainer(inContainer(outside), KEYS)
    expect(env['AI_BASE_URL']).toBe(outside.AI_BASE_URL)
    expect(env['VOLCANO_TTS_BASE_URL']).toBe(outside.VOLCANO_TTS_BASE_URL)
    expect(rewrites).toEqual([])
  })

  it('同一台机器上的内网地址不动（它在容器里本来就通）', () => {
    const { rewrites } = rewriteLoopbackForContainer(
      inContainer({ AI_BASE_URL: 'http://192.168.0.108:38080' }),
      KEYS,
    )
    expect(rewrites).toEqual([])
  })

  it('两个地址都是回环时都改，并逐条报出来', () => {
    const { rewrites } = rewriteLoopbackForContainer(
      inContainer({
        AI_BASE_URL: 'http://127.0.0.1:38080',
        VOLCANO_TTS_BASE_URL: 'http://localhost:9000/tts',
      }),
      KEYS,
    )
    expect(rewrites.map((r) => r.key)).toEqual(['AI_BASE_URL', 'VOLCANO_TTS_BASE_URL'])
  })

  it('不在容器里就一个字都不改', () => {
    const { env, rewrites } = rewriteLoopbackForContainer(
      { AI_BASE_URL: 'http://127.0.0.1:38080' },
      KEYS,
    )
    expect(env['AI_BASE_URL']).toBe('http://127.0.0.1:38080')
    expect(rewrites).toEqual([])
  })

  it('DISABLE_LOOPBACK_REWRITE=1 可以完全关掉', () => {
    const { env, rewrites } = rewriteLoopbackForContainer(
      inContainer({ AI_BASE_URL: 'http://127.0.0.1:38080', DISABLE_LOOPBACK_REWRITE: '1' }),
      KEYS,
    )
    expect(env['AI_BASE_URL']).toBe('http://127.0.0.1:38080')
    expect(rewrites).toEqual([])
  })

  it('不是合法 URL 的值不碰——猜不出该改哪一段', () => {
    const { env, rewrites } = rewriteLoopbackForContainer(
      inContainer({ AI_BASE_URL: '127.0.0.1:38080' }),
      KEYS,
    )
    expect(env['AI_BASE_URL']).toBe('127.0.0.1:38080')
    expect(rewrites).toEqual([])
  })

  it('空值和未设置都跳过', () => {
    const { rewrites } = rewriteLoopbackForContainer(inContainer({ AI_BASE_URL: '  ' }), KEYS)
    expect(rewrites).toEqual([])
  })

  it('不修改传入的 env 对象本身', () => {
    const original = inContainer({ AI_BASE_URL: 'http://127.0.0.1:38080' })
    rewriteLoopbackForContainer(original, KEYS)
    expect(original['AI_BASE_URL']).toBe('http://127.0.0.1:38080')
  })
})
