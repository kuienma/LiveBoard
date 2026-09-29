/**
 * 从模型的纯文本回复里抽出 JSON。
 *
 * 只在「网关不支持结构化输出」的退化路径上用。模型即使被要求只输出 JSON，
 * 也常见包一层 ```json 代码块，或在前后多说一句话，所以这里做括号配对扫描，
 * 而不是简单的正则或 indexOf('{')..lastIndexOf('}')——后者遇到 JSON 后面还有
 * 说明文字、或字符串里含大括号时会截错。
 */
export function extractJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') {
    throw new Error('模型没有返回任何内容')
  }

  // 先扒掉 ```json ... ``` 围栏
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(trimmed)
  const candidate = fenced?.[1]?.trim() ?? trimmed

  const balanced = findBalancedObject(candidate) ?? findBalancedObject(trimmed)
  if (balanced === undefined) {
    const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
    throw new Error(`模型的回复里找不到完整的 JSON 对象。开头是：${preview}`)
  }
  return balanced
}

/** 扫描出第一个大括号配对完整的 JSON 对象，正确跳过字符串内的括号与转义。 */
function findBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]!

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth++
      continue
    }
    if (char === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return undefined
}
