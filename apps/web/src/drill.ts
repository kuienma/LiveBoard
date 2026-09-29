import { compileDrill, type Timeline } from '@drill/engine'
import { formatIssues, parseDrill, type Drill } from '@drill/schema'
import raw from '../../../fixtures/side-attack.json'

export type LoadResult =
  | { ok: true; drill: Drill; timelines: Timeline[] }
  | { ok: false; message: string }

/**
 * 阶段一内置示例数据，不接 AI。
 * 故意把校验放在这里跑一遍：数据有问题时界面直接显示中文错误列表，而不是白屏。
 */
export function loadBuiltInDrill(): LoadResult {
  const result = parseDrill(raw)
  if (!result.ok) {
    return { ok: false, message: formatIssues(result.issues) }
  }
  return { ok: true, drill: result.drill, timelines: compileDrill(result.drill) }
}
