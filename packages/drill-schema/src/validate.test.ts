import { describe, expect, it } from 'vitest'
import fixture from '../../../fixtures/side-attack.json'
import { formatIssues, parseDrill } from './validate.js'

/** 每个用例都从示例数据克隆一份再改坏，互不影响。 */
function broken(): any {
  return structuredClone(fixture)
}

/** 断言校验失败，并返回命中指定 path 前缀的那条错误。 */
function expectIssueAt(input: unknown, pathPrefix: string) {
  const result = parseDrill(input)
  if (result.ok) {
    throw new Error(`期望校验失败，但通过了`)
  }
  const hit = result.issues.find((issue) => issue.path.startsWith(pathPrefix))
  expect(
    hit,
    `没有在 ${pathPrefix} 上报错，实际报错：\n${formatIssues(result.issues)}`,
  ).toBeDefined()
  return hit!
}

describe('示例数据', () => {
  it('通过校验', () => {
    const result = parseDrill(fixture)
    if (!result.ok) {
      throw new Error(`示例数据应当通过校验，但报错：\n${formatIssues(result.issues)}`)
    }
    expect(result.drill.variants.map((v) => v.id)).toEqual(['basic', 'var1', 'var2'])
  })

  it('补齐缺省值', () => {
    const result = parseDrill(fixture)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // field.boundary 没写 → 默认画边线
    expect(result.drill.field.boundary).toBe(true)
    expect(result.drill.field.style).toBe('grass')

    // 锥桶没写 size → 默认矮桶；中间那个写了 tall
    const start = result.drill.objects.find((o) => o.id === 'start')
    const mid = result.drill.objects.find((o) => o.id === 'mid')
    expect(start?.size).toBe('short')
    expect(mid?.size).toBe('tall')

    // phase.slowMotion 没写 → false
    const basic = result.drill.variants[0]!
    expect(basic.phases[0]!.slowMotion).toBe(false)
    expect(basic.phases[1]!.slowMotion).toBe(true)

    // repeat.times = 总轮数
    expect(basic.repeat?.times).toBe(3)
    expect(result.drill.variants[2]!.repeat?.swap).toEqual(['left', 'right'])
  })
})

describe('引用了不存在的 id', () => {
  it('turn.awayFrom 指向不存在的球员', () => {
    const drill = broken()
    drill.variants[0].phases[1].actions[0].awayFrom = 'C'
    const issue = expectIssueAt(drill, 'variants[0].phases[1].actions[0].awayFrom')
    expect(issue.message).toContain('不存在的 id「C」')
  })

  it('位置引用的 at 指向不存在的锥桶', () => {
    const drill = broken()
    drill.variants[0].phases[0].actions[0].to = { at: 'nope', offset: [0, 0] }
    const issue = expectIssueAt(drill, 'variants[0].phases[0].actions[0].to.at')
    expect(issue.message).toContain('不存在的 id「nope」')
  })

  it('动作的 actor 不是已存在的球员', () => {
    const drill = broken()
    drill.variants[0].phases[0].actions[0].actor = 'X'
    const issue = expectIssueAt(drill, 'variants[0].phases[0].actions[0].actor')
    expect(issue.message).toContain('不存在的球员 id「X」')
  })

  it('球的归属指向不存在的球员', () => {
    const drill = broken()
    drill.balls[0].owner = 'Z'
    expectIssueAt(drill, 'balls[0].owner')
  })

  it('repeat.swap 引用不存在的锥桶', () => {
    const drill = broken()
    drill.variants[2].repeat.swap = ['left', 'nowhere']
    const issue = expectIssueAt(drill, 'variants[2].repeat.swap')
    expect(issue.message).toContain('不存在的 id「nowhere」')
  })
})

describe('坐标越界', () => {
  it('锥桶被放到场地外', () => {
    const drill = broken()
    drill.objects[0].pos = [25, 3]
    const issue = expectIssueAt(drill, 'objects[0].pos')
    expect(issue.message).toContain('超出场地范围')
    expect(issue.message).toContain('0..20 × 0..15')
  })

  it('相对位置加上偏移后越界', () => {
    const drill = broken()
    // start 在 [10, 13]，再往下 5 米就出了 15 米高的场地
    drill.variants[0].setup.A = { at: 'start', offset: [0, 5] }
    const issue = expectIssueAt(drill, 'variants[0].setup.A')
    expect(issue.message).toContain('超出场地范围')
  })

  it('负坐标也算越界', () => {
    const drill = broken()
    drill.actors[2].pos = [-1, 5]
    expectIssueAt(drill, 'actors[2].pos')
  })
})

describe('Schema 层面的错误', () => {
  it('出现未知字段', () => {
    const drill = broken()
    drill.field.wdith = 20
    const issue = expectIssueAt(drill, 'field')
    expect(issue.message).toContain('未知字段')
    expect(issue.message).toContain('wdith')
  })

  it('练法没有任何阶段', () => {
    const drill = broken()
    drill.variants[0].phases = []
    const issue = expectIssueAt(drill, 'variants[0].phases')
    expect(issue.message).toContain('至少')
  })

  it('时长必须为正', () => {
    const drill = broken()
    drill.variants[0].phases[0].duration = 0
    expectIssueAt(drill, 'variants[0].phases[0].duration')
  })

  it('动作类型不认识', () => {
    const drill = broken()
    drill.variants[0].phases[0].actions[0].type = 'teleport'
    expectIssueAt(drill, 'variants[0].phases[0].actions[0]')
  })

  it('位置写成了不认识的形状', () => {
    const drill = broken()
    drill.variants[0].phases[0].actions[0].to = { x: 1, y: 2 }
    const issue = expectIssueAt(drill, 'variants[0].phases[0].actions[0].to')
    expect(issue.message).toContain('位置应为')
  })

  it('version 必须是 1', () => {
    const drill = broken()
    drill.version = 2
    expectIssueAt(drill, 'version')
  })
})

describe('业务规则', () => {
  it('dribble 的球员必须持球', () => {
    const drill = broken()
    drill.balls[0].owner = 'B' // 球给了防守者，A 就不能带球了
    const issue = expectIssueAt(drill, 'variants[0].phases[0].actions[0]')
    expect(issue.message).toContain('并未持球')
  })

  it('id 必须全局唯一', () => {
    const drill = broken()
    drill.actors[1].id = 'mid' // 和中间锥桶撞了
    const issue = expectIssueAt(drill, 'actors[1]')
    expect(issue.message).toContain('全局唯一')
  })

  it('同一阶段里同一个球员不能有两个动作', () => {
    const drill = broken()
    drill.variants[0].phases[0].actions.push({
      actor: 'A',
      type: 'wait',
    })
    const issue = expectIssueAt(drill, 'variants[0].phases[0].actions[2]')
    expect(issue.message).toContain('同时发生')
  })

  it('参与动作的球员必须有初始位置', () => {
    const drill = broken()
    delete drill.variants[0].setup.B
    const issue = expectIssueAt(drill, 'variants[0].setup')
    expect(issue.message).toContain('没有初始位置')
  })

  it('球必须指定 owner 或 pos', () => {
    const drill = broken()
    delete drill.balls[0].owner
    expectIssueAt(drill, 'balls[0]')
  })

  it('所有练法都没有动作的空壳数据被拒绝', () => {
    // 模型识别失败时容易编出这种「字段齐全但没内容」的占位数据
    const drill = broken()
    for (const variant of drill.variants) {
      for (const phase of variant.phases) phase.actions = []
    }
    const issue = expectIssueAt(drill, 'variants')
    expect(issue.message).toContain('没有任何动作')
  })

  it('只要有一个动作就放行', () => {
    const drill = broken()
    drill.variants = [drill.variants[0]]
    drill.variants[0].phases = [drill.variants[0].phases[0]]
    expect(parseDrill(drill).ok).toBe(true)
  })

  it('swap 和 rotate 不能同时出现', () => {
    const drill = broken()
    drill.variants[2].repeat.rotate = ['left', 'right']
    const issue = expectIssueAt(drill, 'variants[2].repeat')
    expect(issue.message).toContain('不能同时出现')
  })

  it('rotate 里的 id 不能重复', () => {
    const drill = broken()
    delete drill.variants[2].repeat.swap
    drill.variants[2].repeat.rotate = ['left', 'right', 'left']
    const issue = expectIssueAt(drill, 'variants[2].repeat.rotate')
    expect(issue.message).toContain('重复')
  })

  it('rotate 引用不存在的 id 会被拒绝', () => {
    const drill = broken()
    delete drill.variants[2].repeat.swap
    drill.variants[2].repeat.rotate = ['left', 'right', 'nowhere']
    const issue = expectIssueAt(drill, 'variants[2].repeat.rotate')
    expect(issue.message).toContain('不存在的 id「nowhere」')
  })

  it('rotate 至少要两个 id', () => {
    const drill = broken()
    delete drill.variants[2].repeat.swap
    drill.variants[2].repeat.rotate = ['left']
    expectIssueAt(drill, 'variants[2].repeat.rotate')
  })

  it('练法 id 不能重复', () => {
    const drill = broken()
    drill.variants[1].id = 'basic'
    expectIssueAt(drill, 'variants[1].id')
  })
})

describe('错误文案定稿', () => {
  /** 这些文案会直接显示给用户、也会发回模型重试，所以逐字钉住。 */
  const cases: Array<[string, (drill: any) => void, string]> = [
    [
      '引用不存在的 id',
      (d) => {
        d.variants[0].phases[1].actions[0].awayFrom = 'C'
      },
      '- variants[0].phases[1].actions[0].awayFrom：引用了不存在的 id「C」',
    ],
    [
      '坐标越界',
      (d) => {
        d.objects[0].pos = [25, 3]
      },
      '- objects[0].pos：坐标 [25, 3] 超出场地范围（0..20 × 0..15）',
    ],
    [
      '相对位置加偏移后越界',
      (d) => {
        d.variants[0].setup.A = { at: 'start', offset: [0, 5] }
      },
      '- variants[0].setup.A：坐标 [10, 18] 超出场地范围（0..20 × 0..15）',
    ],
    [
      '字段拼错',
      (d) => {
        d.field.wdith = 20
      },
      '- field：出现未知字段：wdith',
    ],
    [
      '球员没持球却要带球',
      (d) => {
        d.balls[0].owner = 'B'
      },
      '- variants[0].phases[0].actions[0]：第 1 轮时球员「A」并未持球，不能 dribble',
    ],
  ]

  for (const [name, corrupt, expected] of cases) {
    it(name, () => {
      const drill = broken()
      corrupt(drill)
      const result = parseDrill(drill)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(formatIssues(result.issues).split('\n')).toContain(expected)
    })
  }
})

describe('错误信息可读', () => {
  it('formatIssues 输出带路径的中文列表', () => {
    const drill = broken()
    drill.objects[0].pos = [99, 99]
    const result = parseDrill(drill)
    expect(result.ok).toBe(false)
    if (result.ok) return

    const text = formatIssues(result.issues)
    expect(text).toMatch(/^- objects\[0\]\.pos：/)
    expect(text).not.toMatch(/[Ee]xpected|[Ii]nvalid|[Rr]equired/)
  })
})
