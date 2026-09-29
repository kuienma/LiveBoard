import type { Drill } from '@drill/schema'

export interface DrillSummary {
  id: string
  title: string
  category: string
  source?: string
  thumbnail?: string
  createdAt: number
  updatedAt: number
  variantCount: number
}

export interface DrillDetail extends DrillSummary {
  drill: Drill
}

export interface VersionSummary {
  id: number
  origin: string
  originLabel: string
  restoredFrom?: number
  createdAt: number
}

export interface ImportResult {
  imported: DrillSummary[]
  rejected: Array<{ index: number; title?: string; reason: string }>
}

export type VersionOrigin = 'recognition' | 'manual' | 'ai-revise' | 'import' | 'restore'

/** 后端的错误消息本来就是中文且可读，直接抛出去给界面显示。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    throw new ApiError(
      `连不上后端（${error instanceof Error ? error.message : String(error)}）。确认已运行 pnpm dev:api。`,
      0,
    )
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    throw new ApiError(body.message ?? `服务返回 ${response.status}`, response.status)
  }

  return (await response.json()) as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export async function listDrills(filter: { q?: string; category?: string } = {}) {
  const params = new URLSearchParams()
  if (filter.q !== undefined && filter.q !== '') params.set('q', filter.q)
  if (filter.category !== undefined && filter.category !== '') params.set('category', filter.category)
  const query = params.toString()
  const body = await request<{ drills: DrillSummary[] }>(
    `/api/drills${query === '' ? '' : `?${query}`}`,
  )
  return body.drills
}

export const getDrill = (id: string) => request<DrillDetail>(`/api/drills/${id}`)

export const createDrill = (input: {
  drill: Drill
  origin: VersionOrigin
  thumbnail?: string
}) => request<DrillDetail>('/api/drills', jsonInit('POST', input))

export const updateDrill = (
  id: string,
  input: { drill: Drill; origin: VersionOrigin; thumbnail?: string },
) => request<DrillDetail>(`/api/drills/${id}`, jsonInit('PUT', input))

export const deleteDrill = (id: string) =>
  request<{ ok: true }>(`/api/drills/${id}`, { method: 'DELETE' })

export const duplicateDrill = (id: string) =>
  request<DrillDetail>(`/api/drills/${id}/duplicate`, { method: 'POST' })

export const listVersions = async (id: string) =>
  (await request<{ versions: VersionSummary[] }>(`/api/drills/${id}/versions`)).versions

export const restoreVersion = (id: string, versionId: number) =>
  request<DrillDetail>(`/api/drills/${id}/versions/${versionId}/restore`, { method: 'POST' })

/** 导出走浏览器下载，不经过 fetch，这样手机能直接存文件。 */
export function exportUrl(ids?: string[]): string {
  if (ids === undefined || ids.length === 0) return '/api/drills/export'
  const params = new URLSearchParams()
  for (const id of ids) params.append('id', id)
  return `/api/drills/export?${params.toString()}`
}

// ── 视频 / 静态图导出 ────────────────────────────────────────────

export type Orientation = 'landscape' | 'portrait'
export type ExportStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ExportTask {
  id: string
  title: string
  status: ExportStatus
  done: number
  total: number
  ready: boolean
  createdAt: number
  finishedAt?: number
  fileName?: string
  bytes?: number
  durationSeconds?: number
  message?: string
  /** 配音结果说明（没开 / 已配音 N 句 / 为什么没配上）。 */
  narration?: string
}

export interface CreateExportInput {
  drillId: string
  orientation: Orientation
  variantIds?: string[]
  showNarration?: boolean
  voiceOver?: boolean
}

/** 服务端能力探测：有没有配置语音合成。 */
export const getHealth = () => request<{ ok: boolean; voiceOver?: boolean }>('/api/health')

export const createExport = async (input: CreateExportInput) =>
  (await request<{ task: ExportTask }>('/api/exports', jsonInit('POST', input))).task

export const getExport = async (id: string) =>
  (await request<{ task: ExportTask }>(`/api/exports/${id}`)).task

export const cancelExport = (id: string) =>
  request<{ ok: boolean }>(`/api/exports/${id}`, { method: 'DELETE' })

/** 视频和静态图都走浏览器下载：手机上才能「保存到相册 / 文件」。 */
export const exportVideoUrl = (taskId: string) => `/api/exports/${taskId}/file`

export function stillPngUrl(drillId: string, variantId: string, orientation: Orientation): string {
  const params = new URLSearchParams({ variant: variantId, orientation })
  return `/api/drills/${drillId}/png?${params.toString()}`
}

export async function importFile(file: File): Promise<ImportResult> {
  const text = await file.text()
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new ApiError('这个文件不是合法的 JSON，可能已损坏或选错了文件', 400)
  }
  return request<ImportResult>('/api/drills/import', jsonInit('POST', payload))
}

/** 类别的中文名，用于筛选条和卡片。 */
export const CATEGORY_LABEL: Record<string, string> = {
  dribbling: '运球',
  passing: '传球',
  shooting: '射门',
  defending: '防守',
  goalkeeping: '守门',
  fitness: '体能',
  warmup: '热身',
  smallSidedGame: '小场比赛',
  other: '其他',
}
