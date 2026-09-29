/**
 * 合成一句话，验证凭证、音色和端点是否可用。
 *
 * 用法：pnpm probe:tts ["要合成的文字"] [音色 ID]
 * 只发一句短话，计费字符数会打印出来。
 */
import { writeFile } from 'node:fs/promises'
import { VolcanoTtsProvider } from '../src/index.js'

const [, , text = '第 1 次：防守者从右边来，运球员向左转身', voiceArg] = process.argv

const speaker = voiceArg ?? process.env['TTS_VOICE'] ?? ''
const baseUrl = process.env['VOLCANO_TTS_BASE_URL']
const resourceId = process.env['VOLCANO_TTS_RESOURCE_ID']

console.log(`端点：${baseUrl ?? '(默认官方地址)'}`)
console.log(`resource id：${resourceId ?? 'seed-tts-2.0'}`)
console.log(`音色：${speaker}`)
console.log(`文本：${text}（${text.length} 字）\n`)

const provider = new VolcanoTtsProvider({
  speaker,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  ...(resourceId === undefined ? {} : { resourceId }),
  ...(process.env['VOLCANO_TTS_API_KEY'] === undefined
    ? {}
    : { apiKey: process.env['VOLCANO_TTS_API_KEY'] }),
  ...(process.env['VOLCANO_TTS_APP_ID'] === undefined
    ? {}
    : { appId: process.env['VOLCANO_TTS_APP_ID'] }),
  ...(process.env['VOLCANO_TTS_ACCESS_KEY'] === undefined
    ? {}
    : { accessKey: process.env['VOLCANO_TTS_ACCESS_KEY'] }),
  onUsage: ({ characters }) => console.log(`计费字符数：${characters}`),
})

try {
  const started = Date.now()
  const audio = await provider.synthesize({ text })
  const out = `/tmp/tts-probe.${audio.format}`
  await writeFile(out, audio.data)
  console.log(
    `✓ 合成成功：${out}  ${(audio.data.length / 1024).toFixed(1)} KB，` +
      `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  )
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
