import { describe, expect, it } from 'vitest'
import { describeConfig, loadAiConfig, MissingCredentialError } from './config.js'

describe('读取模型配置', () => {
  it('默认走 anthropic 协议与 claude-opus-5', () => {
    const config = loadAiConfig({ AI_API_KEY: 'k' })
    expect(config.kind).toBe('anthropic')
    expect(config.model).toBe('claude-opus-5')
    expect(config.maxOutputTokens).toBe(16000)
    expect(config.baseUrl).toBeUndefined()
  })

  it('本地网关的配置能完整读出来', () => {
    const config = loadAiConfig({
      AI_PROVIDER: 'anthropic',
      AI_BASE_URL: 'http://127.0.0.1:38080',
      AI_API_KEY: 'gateway-token',
      AI_MODEL: 'claude-opus-5',
      AI_EFFORT: 'high',
    })
    expect(config.baseUrl).toBe('http://127.0.0.1:38080')
    expect(config.apiKey).toBe('gateway-token')
    expect(config.effort).toBe('high')
  })

  it('切成 openai 协议只改环境变量', () => {
    const config = loadAiConfig({
      AI_PROVIDER: 'openai',
      AI_BASE_URL: 'http://127.0.0.1:8000/v1',
      AI_API_KEY: 'sk-x',
      AI_MODEL: 'qwen-vl-max',
    })
    expect(config.kind).toBe('openai')
    expect(config.model).toBe('qwen-vl-max')
    expect(config.authStyle).toBe('bearer')
  })

  it('claude 和 openai-compatible 是可接受的别名', () => {
    expect(loadAiConfig({ AI_PROVIDER: 'claude', AI_API_KEY: 'k' }).kind).toBe('anthropic')
    expect(loadAiConfig({ AI_PROVIDER: 'openai-compatible', AI_API_KEY: 'k' }).kind).toBe('openai')
  })

  it('认不出的协议名直接报错，不猜', () => {
    expect(() => loadAiConfig({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k' })).toThrow('只支持')
  })
})

describe('凭据来源的回退顺序', () => {
  it('AI_API_KEY 优先', () => {
    const config = loadAiConfig({ AI_API_KEY: 'first', ANTHROPIC_AUTH_TOKEN: 'second' })
    expect(config.apiKey).toBe('first')
  })

  it('回退到 ANTHROPIC_AUTH_TOKEN，并按 bearer 发送', () => {
    const config = loadAiConfig({ ANTHROPIC_AUTH_TOKEN: 'tok' })
    expect(config.apiKey).toBe('tok')
    expect(config.authStyle).toBe('bearer')
  })

  it('回退到 ANTHROPIC_API_KEY，并按 x-api-key 发送', () => {
    const config = loadAiConfig({ ANTHROPIC_API_KEY: 'sk-ant' })
    expect(config.apiKey).toBe('sk-ant')
    expect(config.authStyle).toBe('x-api-key')
  })

  it('openai 协议回退到 OPENAI_API_KEY', () => {
    const config = loadAiConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-oai' })
    expect(config.apiKey).toBe('sk-oai')
  })

  it('AI_AUTH_STYLE 可以显式覆盖推断结果', () => {
    const config = loadAiConfig({ AI_API_KEY: 'k', AI_AUTH_STYLE: 'x-api-key' })
    expect(config.authStyle).toBe('x-api-key')
  })

  it('完全没有凭据时给出可操作的报错', () => {
    expect(() => loadAiConfig({})).toThrow(MissingCredentialError)
    expect(() => loadAiConfig({})).toThrow('.env.example')
  })

  it('空字符串不算有凭据', () => {
    expect(() => loadAiConfig({ AI_API_KEY: '   ' })).toThrow(MissingCredentialError)
  })
})

describe('日志脱敏', () => {
  // 这里必须用假密钥：真密钥写进测试就等于写进 git 历史，
  // 一个「断言不泄露密钥」的测试自己泄露密钥是最糟的反讽
  it('describeConfig 不泄露完整密钥', () => {
    const described = describeConfig(
      loadAiConfig({ AI_API_KEY: '0123456789abcdef0123456789abcdef', AI_BASE_URL: 'http://x' }),
    )
    const text = JSON.stringify(described)
    expect(text).not.toContain('0123456789abcdef0123456789abcdef')
    expect(text).toContain('0123')
    expect(text).toContain('32 位')
  })
})
