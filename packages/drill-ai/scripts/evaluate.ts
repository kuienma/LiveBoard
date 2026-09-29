/**
 * 批量评测：把 fixtures/pages/ 下的每一页书页照片跑一遍识别，
 * 输出每页是否通过校验、自动断言结果，以及留给人工勾选的对照清单
 * （docs/spec.md 阶段二验收项）。
 *
 * 跑法（仓库根目录）：
 *   pnpm eval                      # 跑全部未跑过的页
 *   pnpm eval --dry                # 只列出待跑的页，不调模型、不花钱
 *   pnpm eval --only side-attack   # 只跑某一页（可重复）
 *   pnpm eval --force              # 忽略已有结果，全部重跑
 *   pnpm eval --retries 0          # 不重试，省钱
 *
 * ⚠️ 每页都会真实调用大模型。实测单页约 6000+4700 tokens、60 秒。
 * 已经跑过的页默认跳过并复用 out/eval/<名字>.json，所以调报告格式不花钱。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { compileVariant } from '@drill/engine'
import { formatIssues, parseDrill, type Drill } from '@drill/schema'
import {
  createProvider,
  describeConfig,
  loadAiConfig,
  recognizeDrill,
  type PageImage,
  type Usage,
} from '../src/index.js'

const PAGES_DIR = 'fixtures/pages'
const OUT_DIR = 'out/eval'

const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** 可机器判定的期望，放在 <名字>.expect.json。缺了就只做「能否通过校验」这一项。 */
interface Expectation {
  titleContains?: string
  sourceContains?: string
  category?: string
  variants?: number
  objects?: number
  actorsAtLeast?: number
  coachingPointContains?: string
  /**
   * 按顺序逐个指定每个练法的「防守者来向」是否应当逐轮左右交替。
   * 必须逐个指定而不是「至少有一个交替」——后者会放过「把基本练法也做成交替」
   * 这种错误（基本练法交替的话，那条『不断变换转身方向』的变化就没意义了）。
   */
  alternating?: boolean[]
  note?: string
}

interface Check {
  label: string
  pass: boolean
  detail: string
}

interface PageOutcome {
  name: string
  /** 复用了上次的结果，没有重新调模型。 */
  cached: boolean
  ok: boolean
  attempts: number
  seconds: number
  usage: Usage
  understanding: string
  uncertainties: string[]
  failure?: string
  checks: Check[]
}

function parseArgs(argv: string[]) {
  const only: string[] = []
  let dry = false
  let force = false
  let retries: number | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--dry') dry = true
    else if (arg === '--force') force = true
    else if (arg === '--only') only.push(argv[++i] ?? '')
    else if (arg === '--retries') retries = Number.parseInt(argv[++i] ?? '', 10)
    else console.warn(`⚠ 忽略无法识别的参数「${arg}」`)
  }
  return { only, dry, force, ...(retries === undefined ? {} : { retries }) }
}

const args = parseArgs(process.argv.slice(2))

if (!existsSync(PAGES_DIR)) {
  console.error(`找不到 ${PAGES_DIR}/。把书页照片放进去再跑。`)
  process.exit(1)
}

const pages = readdirSync(PAGES_DIR)
  .filter((file) => MEDIA_TYPES[extname(file).toLowerCase()] !== undefined)
  .map((file) => basename(file, extname(file)))
  .filter((name) => args.only.length === 0 || args.only.includes(name))
  .sort()

if (pages.length === 0) {
  console.log(`${PAGES_DIR}/ 里还没有书页照片${args.only.length > 0 ? '（或没有匹配 --only 的）' : ''}。`)
  console.log('每页可以再放两个同名文件：')
  console.log('  <名字>.expect.json    可机器判定的期望（标题、类别、练法数…）')
  console.log('  <名字>.expected.md    书上原文与人工对照清单')
  process.exit(0)
}

console.log(`发现 ${pages.length} 页：${pages.join('、')}`)
if (pages.length < 10) {
  console.log(`⚠ 验收要求至少 10 页不同类型的训练图，当前只有 ${pages.length} 页。`)
}

if (args.dry) {
  console.log('\n--dry：只列出，不调用模型。')
  for (const name of pages) {
    const cached = existsSync(join(OUT_DIR, `${name}.json`))
    const expect = existsSync(join(PAGES_DIR, `${name}.expect.json`))
    const prose = existsSync(join(PAGES_DIR, `${name}.expected.md`))
    console.log(
      `  ${name.padEnd(20)} ${cached ? '已有结果' : '待识别'}　` +
        `期望文件：${expect ? 'expect.json ' : ''}${prose ? 'expected.md' : ''}` +
        `${!expect && !prose ? '（无，只能判断能否通过校验）' : ''}`,
    )
  }
  process.exit(0)
}

const config = loadAiConfig()
console.log('\n模型配置：', JSON.stringify(describeConfig(config)))
const provider = createProvider(config)

mkdirSync(OUT_DIR, { recursive: true })

const outcomes: PageOutcome[] = []

for (const name of pages) {
  const imagePath = findImage(name)
  const cachePath = join(OUT_DIR, `${name}.json`)
  const expectation = readExpectation(name)

  console.log(`\n── ${name}`)

  if (!args.force && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
    const parsed = parseDrill(cached.drill)
    if (parsed.ok) {
      console.log('  复用已有结果（加 --force 可重跑）')
      outcomes.push({
        name,
        cached: true,
        ok: true,
        attempts: cached.attempts ?? 0,
        seconds: cached.seconds ?? 0,
        usage: cached.usage ?? { inputTokens: 0, outputTokens: 0 },
        understanding: cached.understanding ?? '',
        uncertainties: cached.uncertainties ?? [],
        checks: runChecks(parsed.drill, expectation),
      })
      continue
    }
    console.log('  已有结果已通不过当前校验规则，重新识别')
  }

  const image = loadImage(imagePath)
  const startedAt = Date.now()
  let outcome: PageOutcome

  try {
    const result = await recognizeDrill(provider, [image], {
      ...(args.retries === undefined ? {} : { maxRetries: args.retries }),
      onProgress: (event) => {
        if (event.phase === 'requesting') process.stdout.write(`  第 ${event.attempt} 次请求…`)
        if (event.phase === 'validating') process.stdout.write(' 校验…')
        if (event.phase === 'retrying') process.stdout.write(`\n  ${event.issues.length} 处问题，重试`)
      },
    })
    const seconds = (Date.now() - startedAt) / 1000
    process.stdout.write('\n')

    if (result.ok) {
      console.log(`  ✓ 第 ${result.attempts} 次通过（${seconds.toFixed(1)}s）`)
      writeFileSync(
        cachePath,
        `${JSON.stringify(
          {
            drill: result.drill,
            understanding: result.understanding,
            uncertainties: result.uncertainties,
            attempts: result.attempts,
            usage: result.usage,
            seconds,
            model: result.model,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      outcome = {
        name,
        cached: false,
        ok: true,
        attempts: result.attempts,
        seconds,
        usage: result.usage,
        understanding: result.understanding,
        uncertainties: result.uncertainties,
        checks: runChecks(result.drill, expectation),
      }
    } else {
      const failure =
        result.kind === 'not_recognizable'
          ? `模型判断不是训练图：${result.reason ?? ''}`
          : `${result.attempts} 次都没通过校验：\n${formatIssues(result.issues)}`
      console.log(`  ✗ ${result.kind}`)
      outcome = {
        name,
        cached: false,
        ok: false,
        attempts: result.attempts,
        seconds,
        usage: result.usage,
        understanding: '',
        uncertainties: [],
        failure,
        checks: [],
      }
    }
  } catch (error) {
    // 一页出错不中断整批
    process.stdout.write('\n')
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  ✗ 请求出错：${message}`)
    outcome = {
      name,
      cached: false,
      ok: false,
      attempts: 0,
      seconds: (Date.now() - startedAt) / 1000,
      usage: { inputTokens: 0, outputTokens: 0 },
      understanding: '',
      uncertainties: [],
      failure: `请求出错：${message}`,
      checks: [],
    }
  }

  for (const check of outcome.checks) {
    console.log(`    ${check.pass ? '✓' : '✗'} ${check.label}：${check.detail}`)
  }
  outcomes.push(outcome)
}

writeReport(outcomes)
printSummary(outcomes)

const failed = outcomes.filter((o) => !o.ok || o.checks.some((c) => !c.pass))
process.exit(failed.length === 0 ? 0 : 1)

// ── 实现 ─────────────────────────────────────────────────────────

function findImage(name: string): string {
  for (const ext of Object.keys(MEDIA_TYPES)) {
    const path = join(PAGES_DIR, `${name}${ext}`)
    if (existsSync(path)) return path
  }
  throw new Error(`找不到 ${name} 对应的图片`)
}

function loadImage(path: string): PageImage {
  const mediaType = MEDIA_TYPES[extname(path).toLowerCase()]
  if (mediaType === undefined) throw new Error(`不支持的图片格式：${path}`)
  return { mediaType, base64: readFileSync(path).toString('base64') }
}

function readExpectation(name: string): Expectation | undefined {
  const path = join(PAGES_DIR, `${name}.expect.json`)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as Expectation
}

/** 能自动判定的都自动判定；主观的（布局像不像、动作顺序对不对）留给人工看报告。 */
function runChecks(drill: Drill, expect: Expectation | undefined): Check[] {
  const checks: Check[] = []
  const add = (label: string, pass: boolean, detail: string) => checks.push({ label, pass, detail })

  // 不管有没有期望文件，都要确认每个练法都能编译成时间线
  let compileError: string | undefined
  /** 每个练法的来向序列，用于判断是否逐轮左右交替。 */
  const sideSequences: Array<{ name: string; sides: string[]; alternates: boolean }> = []
  for (const variant of drill.variants) {
    try {
      const timeline = compileVariant(drill, variant.id)
      const sides = timeline.rounds.map((r) => r.opponentSide ?? '-')
      const alternates =
        sides.length > 1 && sides.every((s, i) => i === 0 || (s !== '-' && s !== sides[i - 1]))
      sideSequences.push({ name: variant.name, sides, alternates })
    } catch (error) {
      compileError = `${variant.id}: ${error instanceof Error ? error.message : String(error)}`
      break
    }
  }
  add(
    '全部练法可编译',
    compileError === undefined,
    compileError ?? `${drill.variants.length} 个练法都能生成时间线`,
  )

  if (expect === undefined) {
    add('有期望文件', false, '缺少 <名字>.expect.json，只能判断能否通过校验')
    return checks
  }

  if (expect.titleContains !== undefined) {
    add(
      '标题',
      drill.meta.title.includes(expect.titleContains),
      `期望含「${expect.titleContains}」，实际「${drill.meta.title}」`,
    )
  }
  if (expect.sourceContains !== undefined) {
    const source = drill.meta.source ?? ''
    add(
      '出处',
      source.includes(expect.sourceContains),
      `期望含「${expect.sourceContains}」，实际「${source || '(空)'}」`,
    )
  }
  if (expect.category !== undefined) {
    add('类别', drill.meta.category === expect.category, `期望 ${expect.category}，实际 ${drill.meta.category}`)
  }
  if (expect.variants !== undefined) {
    add(
      '练法数',
      drill.variants.length === expect.variants,
      `期望 ${expect.variants}，实际 ${drill.variants.length}`,
    )
  }
  if (expect.objects !== undefined) {
    add('器材数', drill.objects.length === expect.objects, `期望 ${expect.objects}，实际 ${drill.objects.length}`)
  }
  if (expect.actorsAtLeast !== undefined) {
    add(
      '角色数',
      drill.actors.length >= expect.actorsAtLeast,
      `期望 ≥${expect.actorsAtLeast}，实际 ${drill.actors.length}`,
    )
  }
  if (expect.coachingPointContains !== undefined) {
    const hit = drill.meta.coachingPoints.some((point) =>
      point.includes(expect.coachingPointContains!),
    )
    add('教学要点', hit, `期望含「${expect.coachingPointContains}」，共 ${drill.meta.coachingPoints.length} 条`)
  }
  if (expect.alternating !== undefined) {
    const wanted = expect.alternating
    if (sideSequences.length !== wanted.length) {
      add('来向交替', false, `练法数不对，没法逐个比对（期望 ${wanted.length} 个，实际 ${sideSequences.length} 个）`)
    } else {
      for (const [index, seq] of sideSequences.entries()) {
        const should = wanted[index]!
        add(
          `来向交替 · ${seq.name}`,
          seq.alternates === should,
          `期望${should ? '交替' : '不交替'}，实际 ${seq.sides.join('→')}`,
        )
      }
    }
  }

  return checks
}

function writeReport(outcomes: PageOutcome[]): void {
  const lines: string[] = [
    '# 识别批量评测报告',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 汇总',
    '',
    '| 页 | 校验 | 尝试 | 耗时 | tokens | 自动断言 | 不确定点 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]

  for (const o of outcomes) {
    const passed = o.checks.filter((c) => c.pass).length
    lines.push(
      `| ${o.name} | ${o.ok ? '通过' : '**未通过**'} | ${o.attempts} | ${o.seconds.toFixed(1)}s | ` +
        `${o.usage.inputTokens}+${o.usage.outputTokens} | ${passed}/${o.checks.length} | ${o.uncertainties.length} |`,
    )
  }

  for (const o of outcomes) {
    lines.push('', `## ${o.name}`, '')
    if (o.cached) lines.push('> 复用了上次的识别结果（未重新调用模型）。', '')

    if (!o.ok) {
      lines.push('**识别未通过：**', '', '```', o.failure ?? '(无详情)', '```', '')
    }

    if (o.checks.length > 0) {
      lines.push('### 自动断言', '')
      for (const check of o.checks) {
        lines.push(`- ${check.pass ? '✅' : '❌'} **${check.label}**：${check.detail}`)
      }
      lines.push('')
    }

    if (o.understanding !== '') {
      lines.push('### 模型的理解', '', o.understanding, '')
    }
    if (o.uncertainties.length > 0) {
      lines.push('### 不确定点', '')
      for (const item of o.uncertainties) lines.push(`- ${item}`)
      lines.push('')
    }

    // 人工对照清单：把 expected.md 的内容带进来，勾选框留空
    const prosePath = join(PAGES_DIR, `${o.name}.expected.md`)
    if (existsSync(prosePath)) {
      lines.push('### 人工对照（勾选）', '')
      lines.push('<details><summary>展开书上原文与对照清单</summary>', '')
      lines.push(readFileSync(prosePath, 'utf8').trimEnd())
      lines.push('', '</details>', '')
    } else {
      lines.push(`> 没有 ${o.name}.expected.md，无法做人工对照。`, '')
    }
  }

  const path = join(OUT_DIR, 'report.md')
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  console.log(`\n报告已写出 ${resolve(path)}`)
}

function printSummary(outcomes: PageOutcome[]): void {
  const passedValidation = outcomes.filter((o) => o.ok).length
  const allChecks = outcomes.flatMap((o) => o.checks)
  const passedChecks = allChecks.filter((c) => c.pass).length
  const tokens = outcomes.reduce(
    (sum, o) => sum + o.usage.inputTokens + o.usage.outputTokens,
    0,
  )
  const fresh = outcomes.filter((o) => !o.cached)

  console.log('\n═══ 汇总 ═══')
  console.log(`通过校验：${passedValidation}/${outcomes.length}`)
  console.log(`自动断言：${passedChecks}/${allChecks.length}`)
  console.log(
    `本次实际调用 ${fresh.length} 页，累计 ${tokens} tokens，` +
      `平均 ${fresh.length === 0 ? 0 : (fresh.reduce((s, o) => s + o.seconds, 0) / fresh.length).toFixed(1)}s/页`,
  )

  const problems = outcomes.filter((o) => !o.ok || o.checks.some((c) => !c.pass))
  if (problems.length > 0) {
    console.log(`\n需要人工看的页：${problems.map((o) => o.name).join('、')}`)
  }
}
