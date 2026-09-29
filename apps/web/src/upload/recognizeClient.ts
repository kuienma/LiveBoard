import type { Drill } from '@drill/schema'
import { readSseStream } from './sse.js'

export type RecognizePhase =
  | { kind: 'uploading' }
  | { kind: 'received'; pages: number }
  | { kind: 'requesting'; attempt: number }
  | { kind: 'validating'; attempt: number }
  | { kind: 'retrying'; attempt: number; issueCount: number }

export interface RecognizeMeta {
  attempts: number
  usage: { inputTokens: number; outputTokens: number }
  model: string
  provider: string
  structured?: boolean
}

export type RecognizeOutcome =
  | {
      ok: true
      drill: Drill
      understanding: string
      uncertainties: string[]
      meta: RecognizeMeta
    }
  | {
      ok: false
      /** not_recognizable：这一页不是训练图。invalid：数据反复通不过校验。其余为请求层失败。 */
      kind: 'not_recognizable' | 'invalid' | 'request_failed'
      message: string
      issues?: string
      meta?: RecognizeMeta
    }

/** 中文文案集中在这里，界面直接用。 */
export const PHASE_LABEL: Record<RecognizePhase['kind'], string> = {
  uploading: '上传中',
  received: '已上传，准备识别',
  requesting: '识别中',
  validating: '校验中',
  retrying: '发现问题，正在重试',
}

/**
 * 上传书页并跟随识别进度。
 *
 * 服务端用 SSE 推进度，因为单页识别实测约 33 秒，不给反馈用户会以为卡死。
 */
export async function recognizePages(
  files: File[],
  onPhase: (phase: RecognizePhase) => void,
  signal?: AbortSignal,
): Promise<RecognizeOutcome> {
  const form = new FormData()
  for (const file of files) form.append('pages', file)

  onPhase({ kind: 'uploading' })

  const response = await fetch('/api/recognize', {
    method: 'POST',
    body: form,
    ...(signal === undefined ? {} : { signal }),
  })

  // 限频、入参错误等在开流之前就返回了普通 JSON
  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as Record<string, unknown>)
    const message =
      typeof body.message === 'string'
        ? body.message
        : `服务返回 ${response.status}，请稍后再试`
    return { ok: false, kind: 'request_failed', message }
  }

  let outcome: RecognizeOutcome | undefined

  for await (const event of readSseStream(response)) {
    let data: any
    try {
      data = JSON.parse(event.data)
    } catch {
      continue
    }

    if (event.event === 'progress') {
      onPhase(toPhase(data))
    } else if (event.event === 'result') {
      outcome = data.ok
        ? {
            ok: true,
            drill: data.drill,
            understanding: data.understanding ?? '',
            uncertainties: data.uncertainties ?? [],
            meta: data.meta,
          }
        : {
            ok: false,
            kind: data.kind === 'not_recognizable' ? 'not_recognizable' : 'invalid',
            message: data.message,
            issues: data.issues,
            meta: data.meta,
          }
    } else if (event.event === 'error') {
      outcome = {
        ok: false,
        kind: 'request_failed',
        message: data.message ?? '识别过程出错',
      }
    }
  }

  return (
    outcome ?? {
      ok: false,
      kind: 'request_failed' as const,
      message: '连接中断，没有收到识别结果。请检查后端是否在运行，然后重试。',
    }
  )
}

function toPhase(data: any): RecognizePhase {
  switch (data.phase) {
    case 'received':
      return { kind: 'received', pages: Number(data.pages ?? 1) }
    case 'requesting':
      return { kind: 'requesting', attempt: Number(data.attempt ?? 1) }
    case 'validating':
      return { kind: 'validating', attempt: Number(data.attempt ?? 1) }
    case 'retrying':
      return {
        kind: 'retrying',
        attempt: Number(data.attempt ?? 1),
        issueCount: Number(data.issueCount ?? 0),
      }
    default:
      return { kind: 'uploading' }
  }
}
