/**
 * 单张（或多张）书页照片走一遍完整识别流程，把结果打到终端。
 *
 * 跑法（在仓库根目录）：
 *   pnpm recognize fixtures/pages/side-attack.jpg
 *   pnpm recognize 第1页.jpg 第2页.jpg --out out/side-attack.json
 *   pnpm recognize 图.jpg --retries 0        # 只请求一次，省钱
 *
 * ⚠️ 每次运行都会真实调用大模型、产生费用。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { createProvider, describeConfig, loadAiConfig, recognizeDrill } from '../src/index.js'
import { formatIssues } from '@drill/schema'
import type { PageImage } from '../src/types.js'

const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function parseArgs(argv: string[]): { files: string[]; out?: string; retries?: number } {
  const files: string[] = []
  let out: string | undefined
  let retries: number | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--out') {
      out = argv[++i]
    } else if (arg === '--retries') {
      retries = Number.parseInt(argv[++i] ?? '', 10)
    } else {
      files.push(arg)
    }
  }
  return { files, ...(out === undefined ? {} : { out }), ...(retries === undefined ? {} : { retries }) }
}

function loadImage(path: string): PageImage {
  const ext = extname(path).toLowerCase()
  const mediaType = MEDIA_TYPES[ext]
  if (mediaType === undefined) {
    throw new Error(`不支持的图片格式「${ext}」。支持：${Object.keys(MEDIA_TYPES).join(' / ')}`)
  }
  const bytes = readFileSync(path)
  const sizeMb = bytes.byteLength / 1024 / 1024
  if (sizeMb > 5) {
    console.warn(
      `⚠ ${basename(path)} 有 ${sizeMb.toFixed(1)}MB，偏大。` +
        '正式流程里前端会先压到长边约 2000px。',
    )
  }
  return { mediaType, base64: bytes.toString('base64') }
}

const { files, out, retries } = parseArgs(process.argv.slice(2))

if (files.length === 0) {
  console.error('用法：pnpm recognize <图片> [更多图片…] [--out 输出.json] [--retries N]')
  process.exit(1)
}

const config = loadAiConfig()
console.log('配置：', JSON.stringify(describeConfig(config), null, 2))
console.log(`\n共 ${files.length} 页：${files.map((f) => basename(f)).join('、')}\n`)

const images = files.map(loadImage)
const provider = createProvider(config)

const startedAt = Date.now()
const result = await recognizeDrill(provider, images, {
  ...(retries === undefined ? {} : { maxRetries: retries }),
  onProgress: (event) => {
    if (event.phase === 'requesting') console.log(`→ 第 ${event.attempt} 次请求模型…`)
    if (event.phase === 'validating') console.log(`  校验中…`)
    if (event.phase === 'retrying') {
      console.log(`  未通过校验，${event.issues.length} 个问题，带着错误重试：`)
      console.log(
        formatIssues(event.issues)
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      )
    }
  },
})

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log('')

if (!result.ok) {
  console.error(`✗ ${result.attempts} 次尝试都没通过校验（耗时 ${seconds}s）`)
  console.error(formatIssues(result.issues))
  if (result.lastJson !== undefined) {
    console.error('\n最后一次模型输出（截断到 2000 字）：')
    console.error(result.lastJson.slice(0, 2000))
  }
  console.error(
    `\n用量：${result.usage.inputTokens} + ${result.usage.outputTokens} tokens，模型 ${result.model}`,
  )
  process.exit(2)
}

console.log(`✓ 第 ${result.attempts} 次尝试通过校验（耗时 ${seconds}s）`)
console.log(`  模型 ${result.model}（${result.provider}，结构化输出：${result.structured ? '是' : '否'}）`)
console.log(`  用量 ${result.usage.inputTokens} + ${result.usage.outputTokens} tokens`)
console.log('')
console.log(`标题：${result.drill.meta.title}`)
console.log(`出处：${result.drill.meta.source ?? '(未识别)'}`)
console.log(`类别：${result.drill.meta.category}`)
console.log(`场地：${result.drill.field.width} × ${result.drill.field.height} 米`)
console.log(
  `器材：${result.drill.objects.length} 个，角色：${result.drill.actors.length} 个，球：${result.drill.balls.length} 个`,
)
console.log(`练法：${result.drill.variants.length} 个`)
for (const variant of result.drill.variants) {
  const rounds = variant.repeat?.times ?? 1
  const swap = variant.repeat?.swap
  console.log(
    `  - ${variant.name}：${variant.phases.length} 个阶段 × ${rounds} 轮` +
      (swap === undefined ? '' : `，每轮互换 ${swap[0]} / ${swap[1]}`),
  )
}

console.log('\n模型的理解：')
console.log(result.understanding)

console.log('\n不确定点：')
if (result.uncertainties.length === 0) {
  console.log('  (模型没提出不确定点——书页有歧义时这通常不是好信号)')
} else {
  for (const item of result.uncertainties) console.log(`  - ${item}`)
}

if (out !== undefined) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(result.drill, null, 2)}\n`, 'utf8')
  console.log(`\n已写出 ${out}`)
}
