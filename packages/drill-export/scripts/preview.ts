/**
 * 肉眼检查导出画面的小工具：渲染一张静态图和一段短视频到 /tmp。
 *
 * 用法：pnpm preview:export [drill.json] [变化 id] [landscape|portrait]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { parseDrill } from '@drill/schema'
import { exportVideo, findCjkFonts, renderStillPng, type Orientation } from '../src/index.js'

const [, , file = 'fixtures/side-attack.json', variantId = 'basic', orientationArg = 'landscape'] =
  process.argv
const orientation = orientationArg as Orientation

const parsed = parseDrill(JSON.parse(await readFile(file, 'utf8')))
if (!parsed.ok) {
  console.error('这份 Drill 不合法：', parsed.issues)
  process.exit(1)
}

const fonts = findCjkFonts()
console.log('中文字体：', fonts.length === 0 ? '没找到（说明文字会变方框）' : fonts.slice(0, 4).join('、'))

const png = `/tmp/drill-${variantId}-${orientation}.png`
await writeFile(png, renderStillPng(parsed.drill, variantId, { orientation }))
console.log('静态图：', png)

const mp4 = `/tmp/drill-${variantId}-${orientation}.mp4`
const started = Date.now()
const result = await exportVideo(parsed.drill, mp4, {
  orientation,
  variantIds: [variantId],
  onProgress: ({ done, total }) => {
    if (done % 30 === 0 || done === total) {
      process.stdout.write(`\r渲染 ${done}/${total} 帧`)
    }
  },
})
console.log(
  `\n视频：${mp4}  ${result.width}x${result.height} ${result.durationSeconds}s ` +
    `${result.frames} 帧，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
)
