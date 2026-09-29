/**
 * 把一份 Drill JSON 编译成时间线并打印结构，用来核对「动画是不是真的对」。
 *
 * 光看 JSON 字段齐全说明不了什么——转身方向、swap 后的引用、每轮的来向
 * 都要经过引擎才能算出来。批量评测也复用这个输出。
 *
 * 跑法：pnpm inspect <drill.json>
 */
import { readFileSync } from 'node:fs'
import { compileVariant, sampleTimeline } from '@drill/engine'
import { formatIssues, parseDrill } from '@drill/schema'

const path = process.argv[2]
if (path === undefined) {
  console.error('用法：pnpm inspect <drill.json>')
  process.exit(1)
}

const result = parseDrill(JSON.parse(readFileSync(path, 'utf8')))
if (!result.ok) {
  console.error('✗ 未通过校验：')
  console.error(formatIssues(result.issues))
  process.exit(2)
}
const drill = result.drill

console.log(`${drill.meta.title}　${drill.meta.source ?? ''}　[${drill.meta.category}]`)
console.log(`场地 ${drill.field.width}×${drill.field.height} 米`)
console.log('\n器材：')
for (const o of drill.objects) {
  console.log(`  ${o.id.padEnd(12)} ${o.type} ${o.color} ${o.size} @ [${o.pos.join(', ')}]`)
}

for (const variant of drill.variants) {
  const timeline = compileVariant(drill, variant.id)
  console.log(`\n── ${variant.name}（${timeline.duration.toFixed(1)}s，${timeline.rounds.length} 轮）`)

  console.log('  初始站位：')
  for (const [id, pos] of Object.entries(timeline.initialPositions)) {
    console.log(`    ${id.padEnd(6)} [${pos.map((n) => n.toFixed(2)).join(', ')}]`)
  }

  const sides: string[] = []
  for (const round of timeline.rounds) {
    // 取该轮转身阶段的实际朝向变化
    const turnSegment = timeline.segments.find(
      (s) => s.roundIndex === round.index && s.actors.some((m) => m.turn !== undefined),
    )
    const turning = turnSegment?.actors.find((m) => m.turn !== undefined)
    const direction =
      turning?.turn?.direction === undefined
        ? '（无转身）'
        : turning.turn.direction === -1
          ? '逆时针（画面向左）'
          : '顺时针（画面向右）'

    sides.push(round.opponentSide ?? '-')
    console.log(`  第 ${round.index + 1} 轮  转身：${direction}`)
    console.log(`         顶部文字：${round.narration}`)
    if (turning?.turn?.degenerate === true) {
      console.log('         ⚠ 对手在正前/正后方，转身方向由兜底规则决定')
    }

    // 各球员在该轮结束时的位置
    const last = timeline.segments.filter((s) => s.roundIndex === round.index).at(-1)
    const ends = last?.actors
      .map((m) => `${m.actorId}=[${m.points.at(-1)!.map((n) => n.toFixed(1)).join(',')}]`)
      .join('  ')
    console.log(`         轮末位置：${ends}`)
  }

  const alternates = sides.length > 1 && sides.every((s, i) => i === 0 || s !== sides[i - 1])
  console.log(`  来向序列：${sides.join(' → ')}${alternates ? '（左右交替 ✓）' : ''}`)

  // 抽查转身中点，确认球绕行在哪一侧
  const turnRound = timeline.rounds[0]
  if (turnRound !== undefined) {
    const seg = timeline.segments.find(
      (s) => s.roundIndex === 0 && s.actors.some((m) => m.turn !== undefined),
    )
    if (seg !== undefined) {
      const frame = sampleTimeline(timeline, (seg.startTime + seg.endTime) / 2)
      const turner = seg.actors.find((m) => m.turn !== undefined)!.actorId
      const actor = frame.actors.find((a) => a.id === turner)
      const ball = frame.balls[0]
      if (actor !== undefined && ball !== undefined) {
        const side = ball.pos[0] < actor.pos[0] ? '左' : '右'
        console.log(
          `  第 1 轮转身中点：${turner} 在 [${actor.pos.map((n) => n.toFixed(1)).join(',')}]，` +
            `球在其${side}侧 [${ball.pos.map((n) => n.toFixed(1)).join(',')}]`,
        )
      }
    }
  }
}
