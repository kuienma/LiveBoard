/**
 * 极简 SSE 解析器。
 *
 * 只用 fetch + ReadableStream 读，不用 EventSource——EventSource 只能发 GET，
 * 而识别要 POST 上传图片。做成纯函数式的 feed/flush，方便单测。
 */
export interface SseEvent {
  event: string
  data: string
}

export function createSseParser() {
  let buffer = ''

  return {
    /** 喂入一段文本，返回其中已经完整的事件。 */
    feed(chunk: string): SseEvent[] {
      buffer += chunk
      const events: SseEvent[] = []

      // 事件之间用空行分隔；\r\n 也要吃掉，代理有时会改写换行
      let separator = findSeparator(buffer)
      while (separator !== undefined) {
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator.length)
        const parsed = parseBlock(block)
        if (parsed !== undefined) events.push(parsed)
        separator = findSeparator(buffer)
      }

      return events
    },

    /** 流结束时调用，处理末尾没有空行收尾的最后一块。 */
    flush(): SseEvent[] {
      const parsed = parseBlock(buffer)
      buffer = ''
      return parsed === undefined ? [] : [parsed]
    },
  }
}

function findSeparator(text: string): { index: number; length: number } | undefined {
  const lf = text.indexOf('\n\n')
  const crlf = text.indexOf('\r\n\r\n')
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  if (lf !== -1) return { index: lf, length: 2 }
  return undefined
}

function parseBlock(block: string): SseEvent | undefined {
  let event = 'message'
  const dataLines: string[] = []

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line === '' || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    }
  }

  if (dataLines.length === 0) return undefined
  return { event, data: dataLines.join('\n') }
}

/** 逐个读出响应体里的 SSE 事件。 */
export async function* readSseStream(response: Response): AsyncGenerator<SseEvent> {
  const body = response.body
  if (body === null) throw new Error('响应没有数据流')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
        yield event
      }
    }
    for (const event of parser.flush()) yield event
  } finally {
    reader.releaseLock()
  }
}
