import { parseDrill } from '@drill/schema'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import sideAttack from '../../../fixtures/side-attack.json'
import passingSquare from '../../../fixtures/passing-square.json'
import { buildSystemPrompt, buildUserInstruction } from './prompt.js'
import { recognizeDrill, validate } from './recognize.js'
import type { ProviderRequest, ProviderResponse, VisionProvider } from './types.js'

/** 按脚本回放的假 provider，用来测重试逻辑，不联网。 */
class ScriptedProvider implements VisionProvider {
  readonly kind = 'anthropic' as const
  readonly model = 'test-model'
  readonly received: ProviderRequest[] = []
  private index = 0

  constructor(private readonly replies: string[]) {}

  request(input: ProviderRequest): Promise<ProviderResponse> {
    this.received.push(input)
    const json = this.replies[Math.min(this.index, this.replies.length - 1)]!
    this.index++
    return Promise.resolve({
      json,
      usage: { inputTokens: 100, outputTokens: 50 },
      model: this.model,
      provider: this.kind,
      structured: true,
    })
  }
}

const envelope = (drill: unknown, understanding = '说明', uncertainties: string[] = []) =>
  JSON.stringify({ drill, understanding, uncertainties })

const image = { mediaType: 'image/jpeg', base64: 'AAAA' }

describe('few-shot 示例本身必须是合法数据', () => {
  // 示例是教模型怎么写的范本，自己不合法就是在教错的东西
  it('示例一通过校验', () => {
    const result = parseDrill(sideAttack)
    expect(result.ok).toBe(true)
  })

  it('示例二通过校验', () => {
    const result = parseDrill(passingSquare)
    if (!result.ok) {
      throw new Error(result.issues.map((i) => `${i.path}: ${i.message}`).join('\n'))
    }
    expect(result.drill.variants).toHaveLength(2)
  })
})

describe('system 提示词', () => {
  const prompt = buildSystemPrompt()

  it('包含坐标约定、动作类型和关键语义', () => {
    for (const needle of [
      '原点在**左上角**',
      '顺时针为正',
      'dribble',
      'toward',
      'stopShort',
      'setup` 只在该练法开头应用一次',
      '`repeat.times` 是总轮数',
      'swap',
      '只输出 JSON',
    ]) {
      expect(prompt, `缺少「${needle}」`).toContain(needle)
    }
  })

  it('带上两个完整的 few-shot 示例', () => {
    expect(prompt).toContain('示例一')
    expect(prompt).toContain('示例二')
    expect(prompt).toContain('转身后向边路突破')
    expect(prompt).toContain('四角传球')
    // 示例里要示范承认不确定点
    expect(prompt).toContain('书上没标')
  })

  it('提示词里不能出现验收用例「从侧边进攻」', () => {
    // 它曾经是示例一，导致模型识别那一页时照抄示例坐标，测出来的是记忆不是识别。
    // 示例必须与待测页面是不同的训练，这条用来防止再被放回去。
    expect(prompt).not.toContain('从侧边进攻')
    expect(prompt).not.toContain('"start"'.replaceAll('"', ''))
  })

  it('提示词直接读文件，改 prompts/ 不用改代码', () => {
    const onDisk = readFileSync(
      new URL('../../../prompts/recognize-system.md', import.meta.url),
      'utf8',
    )
    expect(prompt.startsWith(onDisk.trimEnd())).toBe(true)
  })

  it('多页时用户指令会说明页数', () => {
    expect(buildUserInstruction(1)).toContain('一页')
    expect(buildUserInstruction(3)).toContain('3 页')
  })
})

describe('校验模型输出', () => {
  it('合法信封通过', () => {
    const result = validate(envelope(sideAttack, '我的理解', ['不确定尺寸']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.understanding).toBe('我的理解')
    expect(result.uncertainties).toEqual(['不确定尺寸'])
  })

  it('JSON 语法错误被归一成一条错误', () => {
    const result = validate('{"drill": ')
    expect(result.ok).toBe(false)
    if (result.ok || result.kind !== 'invalid') throw new Error('应当是 invalid')
    expect(result.issues[0]!.message).toContain('不是合法的 JSON')
  })

  it('顶层结构不对时明确告知应有的形状', () => {
    const result = validate(JSON.stringify(sideAttack)) // 少了信封
    expect(result.ok).toBe(false)
    if (result.ok || result.kind !== 'invalid') throw new Error('应当是 invalid')
    expect(result.issues[0]!.message).toContain('understanding')
  })

  it('Drill 的错误路径加上 drill. 前缀，和模型看到的结构对齐', () => {
    const broken = structuredClone(sideAttack) as any
    broken.objects[0].pos = [99, 99]
    const result = validate(envelope(broken))
    expect(result.ok).toBe(false)
    if (result.ok || result.kind !== 'invalid') throw new Error('应当是 invalid')
    expect(result.issues.some((i) => i.path === 'drill.objects[0].pos')).toBe(true)
  })

  it('understanding 缺失时补空串而不是失败', () => {
    const result = validate(JSON.stringify({ drill: sideAttack }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.understanding).toBe('')
    expect(result.uncertainties).toEqual([])
  })
})

describe('校验失败后的重试', () => {
  it('一次过时只请求一次', async () => {
    const provider = new ScriptedProvider([envelope(sideAttack)])
    const result = await recognizeDrill(provider, [image])
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(provider.received).toHaveLength(1)
    expect(provider.received[0]!.previousAttempt).toBeUndefined()
  })

  it('第一次失败、第二次成功', async () => {
    const broken = structuredClone(sideAttack) as any
    broken.variants[0].phases[1].actions[0].awayFrom = 'C'
    const provider = new ScriptedProvider([envelope(broken), envelope(sideAttack)])

    const result = await recognizeDrill(provider, [image])
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)

    // 重试时要把上一轮的产出和错误列表一起发回去
    const retry = provider.received[1]!
    expect(retry.previousAttempt).toBeDefined()
    expect(retry.previousAttempt!.issues).toContain('不存在的 id「C」')
    expect(retry.previousAttempt!.json).toContain('"awayFrom":"C"')
  })

  it('两次重试都失败后如实返回失败，不返回没过校验的数据', async () => {
    const provider = new ScriptedProvider(['not json at all'])
    const result = await recognizeDrill(provider, [image])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('invalid')
    expect(result.attempts).toBe(3) // 1 次 + 2 次重试
    expect(provider.received).toHaveLength(3)
    expect(result.issues).not.toHaveLength(0)
    expect(result).not.toHaveProperty('drill')
  })

  it('模型说这一页不是训练图时立刻返回，不浪费重试', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({ recognizable: false, understanding: '这是一张收据，不是训练图。' }),
    ])
    const result = await recognizeDrill(provider, [image])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('not_recognizable')
    expect(result.reason).toContain('收据')
    expect(result.attempts).toBe(1)
    expect(provider.received).toHaveLength(1) // 关键：没有重试
  })

  it('recognizable=false 但没给理由时也有兜底文案', async () => {
    const provider = new ScriptedProvider([JSON.stringify({ recognizable: false })])
    const result = await recognizeDrill(provider, [image])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('不是足球训练教材')
  })

  it('maxRetries 可以配置', async () => {
    const provider = new ScriptedProvider(['{}'])
    const result = await recognizeDrill(provider, [image], { maxRetries: 0 })
    expect(result.attempts).toBe(1)
    expect(provider.received).toHaveLength(1)
  })

  it('token 用量按次累加', async () => {
    const provider = new ScriptedProvider([envelope({}), envelope(sideAttack)])
    const result = await recognizeDrill(provider, [image])
    expect(result.usage.inputTokens).toBe(200)
    expect(result.usage.outputTokens).toBe(100)
  })

  it('进度回调依次报告各阶段', async () => {
    const provider = new ScriptedProvider([envelope({}), envelope(sideAttack)])
    const phases: string[] = []
    await recognizeDrill(provider, [image], {
      onProgress: (event) => phases.push(`${event.phase}${event.attempt}`),
    })
    expect(phases).toEqual([
      'requesting1',
      'validating1',
      'retrying1',
      'requesting2',
      'validating2',
    ])
  })

  it('没有图片直接报错', async () => {
    const provider = new ScriptedProvider([envelope(sideAttack)])
    await expect(recognizeDrill(provider, [])).rejects.toThrow('至少需要一张图片')
  })
})
