import { z } from 'zod'
import { drillSchema, type Drill } from './schema.js'
import { checkRules, type DrillIssue } from './rules.js'

export type ParseResult =
  | { ok: true; drill: Drill }
  | { ok: false; issues: DrillIssue[] }

/**
 * 解析并校验一份 Drill JSON：先 Schema，再业务规则。
 * 失败时返回可读的错误列表（可直接发回模型重试，见 docs/spec.md 第 4.1 节）。
 */
export function parseDrill(input: unknown): ParseResult {
  const parsed = drillSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, issues: translateZodIssues(parsed.error) }
  }

  const issues = checkRules(parsed.data)
  if (issues.length > 0) {
    return { ok: false, issues }
  }

  return { ok: true, drill: parsed.data }
}

/** 把错误列表拼成一段人读的文本，用于界面提示和重试提示词。 */
export function formatIssues(issues: DrillIssue[]): string {
  return issues.map((issue) => `- ${issue.path || '(根)'}：${issue.message}`).join('\n')
}

function pathToString(path: ReadonlyArray<PropertyKey>): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`
    } else {
      out += out === '' ? String(segment) : `.${String(segment)}`
    }
  }
  return out
}

type ZodIssue = z.ZodError['issues'][number]

/** schema.ts 里手写的报错已经是中文，含中文字符就直接用，不要被下面的通用翻译覆盖。 */
const hasChinese = (text: string) => /[一-鿿]/.test(text)

/** Zod 的报错默认是英文，这里转成中文；界面语言是简体中文（见 docs/spec.md 第 7 节）。 */
function translateZodIssues(error: z.ZodError): DrillIssue[] {
  return error.issues.map((issue) => ({
    path: pathToString(issue.path),
    message: hasChinese(issue.message) ? issue.message : translateZodIssue(issue),
  }))
}

function translateZodIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `字段类型不对，期望 ${issue.expected}`
    case 'unrecognized_keys':
      return `出现未知字段：${issue.keys.join('、')}`
    case 'invalid_value': {
      const values = issue.values.map((v) => String(v)).join(' / ')
      return `取值不合法，只允许：${values}`
    }
    case 'too_small':
      return issue.origin === 'array'
        ? `至少需要 ${issue.minimum} 项`
        : `数值不能小于 ${issue.minimum}`
    case 'too_big':
      return issue.origin === 'array'
        ? `最多只能有 ${issue.maximum} 项`
        : `数值不能大于 ${issue.maximum}`
    case 'invalid_union':
      return '格式不符合任何一种允许的写法（位置应为 [x, y] 或 { at, offset } 或 { toward, stopShort }）'
    case 'invalid_format':
      return issue.message
    case 'not_multiple_of':
      return `必须是 ${issue.divisor} 的倍数`
    default:
      return issue.message
  }
}
