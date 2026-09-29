/**
 * 配音链路自测：渲染视频 → 合成每句说明 → 混音 → 打印每句实际落点。
 *
 * 用法：pnpm preview:voice [drill.json] [变化 id]
 * 本机用 macOS 的 say 合成，不花钱、文字不出网。
 */
import { readFile } from 'node:fs/promises'
import { parseDrill } from '@drill/schema'
import { CachingTtsProvider, MacSayTtsProvider } from '@drill/tts'
import { addNarration, buildNarrationCues, exportVideo, planVariants } from '../src/index.js'

const [, , file = 'fixtures/side-attack.json', variantId = 'basic'] = process.argv

const parsed = parseDrill(JSON.parse(await readFile(file, 'utf8')))
if (!parsed.ok) {
  console.error('这份 Drill 不合法：', parsed.issues)
  process.exit(1)
}

const variantIds = variantId === 'all' ? parsed.drill.variants.map((v) => v.id) : [variantId]
const plans = planVariants(parsed.drill, variantIds)

const silent = '/tmp/voice-silent.mp4'
await exportVideo(parsed.drill, silent, { orientation: 'landscape', variantIds })
console.log('无声视频：', silent)

const cues = buildNarrationCues(plans)
console.log(`\n共 ${cues.length} 句配音：`)
for (const cue of cues) {
  console.log(`  ${cue.at.toFixed(1)}s（可用 ${cue.window.toFixed(1)}s）  ${cue.text}`)
}

const provider = new CachingTtsProvider(new MacSayTtsProvider(), '/tmp/drill-tts-cache')
const out = '/tmp/voice-narrated.mp4'
const started = Date.now()
const result = await addNarration(silent, out, cues, { provider })
console.log(
  `\n已配音：${out}  ${result.cues} 句，其中 ${result.spedUp} 句提速，` +
    `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
)
