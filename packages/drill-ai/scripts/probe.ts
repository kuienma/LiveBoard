/**
 * 网关能力探测。用最小的请求量问清三件事：
 *   1. 协议 / 凭据 / 模型 id 对不对
 *   2. 网关是否转发图片内容块（识别的前提）
 *   3. 是否支持结构化输出（output_config.format / response_format）
 *
 * 跑法（在仓库根目录）：
 *   node --env-file=.env packages/drill-ai/scripts/probe.ts
 *   node --env-file=.env packages/drill-ai/scripts/probe.ts 某张图.png   # 用真实图片测
 *
 * 刻意不 import 本仓库的 TS 包：Node 默认不为 node_modules 里的 .ts 剥类型，
 * 所以这个脚本自己读环境变量，只依赖两个官方 SDK。
 */
import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

/** 1×1 透明 PNG。没给图片时用它，只验证网关是否接受图片块。 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC'

/** 命令行给了图片路径就用它——1×1 那种退化图片会被一些后端直接拒掉，测不出真实能力。 */
const imagePath = process.argv[2]
const imageBase64 =
  imagePath === undefined ? TINY_PNG : readFileSync(imagePath).toString('base64')
const imageMediaType =
  imagePath === undefined || imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
const imageQuestion =
  imagePath === undefined
    ? '这是一张测试图。只回复两个字：看到'
    : '这张图里有几个圆形？分别是什么颜色？一句话回答。'

const env = process.env
const provider = (env['AI_PROVIDER'] ?? 'anthropic').toLowerCase()
const model = env['AI_MODEL'] ?? ''
const baseUrl = env['AI_BASE_URL'] ?? ''
const apiKey = env['AI_API_KEY'] ?? env['ANTHROPIC_AUTH_TOKEN'] ?? env['OPENAI_API_KEY'] ?? ''
const authStyle = (env['AI_AUTH_STYLE'] ?? 'bearer').toLowerCase()
const effort = env['AI_EFFORT'] ?? ''

if (apiKey === '') {
  console.error('✗ 没读到凭据。先在仓库根目录建好 .env（参考 .env.example）。')
  process.exit(1)
}

console.log('配置：')
console.log(`  协议      ${provider}`)
console.log(`  模型      ${model || '(未设置)'}`)
console.log(`  地址      ${baseUrl || '(SDK 默认)'}`)
console.log(`  凭据      ${apiKey.slice(0, 4)}…（${apiKey.length} 位，${authStyle}）`)
console.log(`  effort    ${effort || '(不发送)'}`)
console.log(`  测试图    ${imagePath ?? '(内置 1×1 PNG)'}`)
console.log('')

type Outcome = { ok: true; note: string } | { ok: false; note: string }

const results: Array<{ name: string; outcome: Outcome }> = []

function record(name: string, outcome: Outcome): void {
  results.push({ name, outcome })
  console.log(`${outcome.ok ? '✓' : '✗'} ${name}：${outcome.note}`)
}

function describeError(error: unknown): string {
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    const message = String(error.message).replace(/\s+/g, ' ').slice(0, 300)
    return `HTTP ${error.status ?? '?'} ${message}`
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 300)
  }
  return String(error).slice(0, 300)
}

async function probeAnthropic(): Promise<void> {
  const options: Record<string, unknown> = {}
  if (baseUrl !== '') options['baseURL'] = baseUrl
  if (authStyle === 'bearer') {
    options['authToken'] = apiKey
    options['apiKey'] = null
  } else {
    options['apiKey'] = apiKey
  }
  const client = new Anthropic(options)

  // 1. 最小文本请求
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: '回复两个字：收到' }],
    })
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
    record('文本请求', {
      ok: true,
      note: `模型回报为「${response.model}」，回复「${text.trim()}」，` +
        `用量 ${response.usage.input_tokens}+${response.usage.output_tokens} tokens`,
    })
  } catch (error) {
    record('文本请求', { ok: false, note: describeError(error) })
    console.log('\n文本请求都不通，后面就不试了。先确认网关在跑、模型 id 和凭据正确。')
    return
  }

  // 2. 图片内容块
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: imageMediaType as 'image/png' | 'image/jpeg',
                data: imageBase64,
              },
            },
            { type: 'text', text: imageQuestion },
          ],
        },
      ],
    })
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
    record('图片内容块', { ok: true, note: `网关接受图片，回复「${text.trim()}」` })
  } catch (error) {
    record('图片内容块', {
      ok: false,
      note: `${describeError(error)} —— 识别功能依赖图片输入，这条不通就走不下去`,
    })
  }

  // 3. 结构化输出
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: '给出一个 name 为「测试」的对象' }],
      // 故意用最小的 schema，只探参数是否被接受
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
    } as Anthropic.MessageCreateParamsNonStreaming)
    record('结构化输出', { ok: true, note: '网关接受 output_config.format，可以强制符合 Schema' })
  } catch (error) {
    record('结构化输出', {
      ok: false,
      note: `${describeError(error)} —— 不支持没关系，代码会自动退化成「提示词约束 + 自行抽取 JSON」`,
    })
  }

  // 4. effort（仅在配置了的时候试）
  if (effort !== '') {
    try {
      await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: '回复：好' }],
        output_config: { effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
      })
      record('effort 档位', { ok: true, note: `接受 effort=${effort}` })
    } catch (error) {
      record('effort 档位', {
        ok: false,
        note: `${describeError(error)} —— 请把 .env 里的 AI_EFFORT 留空`,
      })
    }
  }
}

async function probeOpenai(): Promise<void> {
  const options: Record<string, unknown> = { apiKey }
  if (baseUrl !== '') options['baseURL'] = baseUrl
  const client = new OpenAI(options)

  try {
    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: 16,
      messages: [{ role: 'user', content: '回复两个字：收到' }],
    })
    record('文本请求', {
      ok: true,
      note: `模型回报为「${response.model}」，回复「${response.choices[0]?.message.content?.trim() ?? ''}」`,
    })
  } catch (error) {
    record('文本请求', { ok: false, note: describeError(error) })
    return
  }

  try {
    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${imageMediaType};base64,${imageBase64}` },
            },
            { type: 'text', text: imageQuestion },
          ],
        },
      ],
    })
    record('图片内容块', {
      ok: true,
      note: `网关接受图片，回复「${response.choices[0]?.message.content?.trim() ?? ''}」`,
    })
  } catch (error) {
    record('图片内容块', { ok: false, note: describeError(error) })
  }

  try {
    await client.chat.completions.create({
      model,
      max_completion_tokens: 64,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: '用 JSON 给出一个 name 为「测试」的对象' }],
    })
    record('JSON 模式', { ok: true, note: '网关接受 response_format=json_object' })
  } catch (error) {
    record('JSON 模式', {
      ok: false,
      note: `${describeError(error)} —— 会自动退化成提示词约束`,
    })
  }
}

if (provider === 'anthropic' || provider === 'claude') {
  await probeAnthropic()
} else {
  await probeOpenai()
}

console.log('')
const failed = results.filter((r) => !r.outcome.ok)
if (failed.length === 0) {
  console.log('全部通过，可以进行真实识别了。')
} else {
  console.log(`${failed.length} 项未通过：${failed.map((r) => r.name).join('、')}`)
  console.log('上面每条都写了该怎么处理。')
}
