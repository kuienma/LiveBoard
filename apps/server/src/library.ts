import { formatIssues, parseDrill, type Drill, type DrillIssue } from '@drill/schema'
import { and, desc, eq, like, type SQL } from 'drizzle-orm'
import {
  drillVersions,
  drills,
  MAX_VERSIONS_PER_DRILL,
  type Db,
  type VersionOrigin,
} from './db/index.js'

/** 导出文件的格式版本。与 Drill JSON 自身的 version 是两回事。 */
export const EXPORT_FORMAT = 'drill-library'
export const EXPORT_VERSION = 1

/** 缩略图上限，防止 data URL 把库撑大。 */
const MAX_THUMBNAIL_BYTES = 200 * 1024

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
  origin: VersionOrigin
  restoredFrom?: number
  createdAt: number
}

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: DrillIssue[],
  ) {
    super(message)
    this.name = 'LibraryError'
  }
}

const notFound = (id: string) => new LibraryError(`找不到 id 为「${id}」的训练`, 404)

/** 校验 Drill 并归一化；所有入口（新建、更新、导入、恢复）都要过这里。 */
function ensureValid(raw: unknown): Drill {
  const result = parseDrill(raw)
  if (!result.ok) {
    throw new LibraryError(
      `训练数据未通过校验：\n${formatIssues(result.issues)}`,
      400,
      result.issues,
    )
  }
  return result.drill
}

function checkThumbnail(thumbnail: string | undefined): string | null {
  if (thumbnail === undefined || thumbnail === '') return null
  if (!thumbnail.startsWith('data:image/')) {
    throw new LibraryError('缩略图必须是 data:image/ 开头的 data URL', 400)
  }
  if (Buffer.byteLength(thumbnail, 'utf8') > MAX_THUMBNAIL_BYTES) {
    throw new LibraryError(`缩略图不能超过 ${MAX_THUMBNAIL_BYTES / 1024}KB`, 400)
  }
  return thumbnail
}

function toSummary(row: typeof drills.$inferSelect): DrillSummary {
  const drill = JSON.parse(row.data) as Drill
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.thumbnail === null ? {} : { thumbnail: row.thumbnail }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    variantCount: drill.variants.length,
  }
}

/**
 * 记一条版本，并把超出上限的老版本删掉（spec 要求至少保留最近 20 个）。
 */
function recordVersion(
  db: Db,
  drillId: string,
  data: string,
  origin: VersionOrigin,
  now: number,
  restoredFrom?: number,
): void {
  db.insert(drillVersions)
    .values({
      drillId,
      data,
      origin,
      restoredFrom: restoredFrom ?? null,
      createdAt: now,
    })
    .run()

  const kept = db
    .select({ id: drillVersions.id })
    .from(drillVersions)
    .where(eq(drillVersions.drillId, drillId))
    .orderBy(desc(drillVersions.createdAt), desc(drillVersions.id))
    .limit(MAX_VERSIONS_PER_DRILL)
    .all()
    .map((row) => row.id)

  for (const row of db
    .select({ id: drillVersions.id })
    .from(drillVersions)
    .where(eq(drillVersions.drillId, drillId))
    .all()) {
    if (!kept.includes(row.id)) {
      db.delete(drillVersions).where(eq(drillVersions.id, row.id)).run()
    }
  }
}

export function listDrills(
  db: Db,
  filter: { q?: string; category?: string } = {},
): DrillSummary[] {
  const conditions: SQL[] = []
  if (filter.category !== undefined && filter.category !== '') {
    conditions.push(eq(drills.category, filter.category))
  }
  if (filter.q !== undefined && filter.q.trim() !== '') {
    // SQLite 的 LIKE 对 ASCII 默认不区分大小写，中文按原样匹配，够用
    conditions.push(like(drills.title, `%${filter.q.trim()}%`))
  }

  const rows =
    conditions.length === 0
      ? db.select().from(drills).orderBy(desc(drills.updatedAt)).all()
      : db
          .select()
          .from(drills)
          .where(conditions.length === 1 ? conditions[0]! : and(...conditions))
          .orderBy(desc(drills.updatedAt))
          .all()

  return rows.map(toSummary)
}

export function getDrill(db: Db, id: string): DrillDetail {
  const row = db.select().from(drills).where(eq(drills.id, id)).get()
  if (row === undefined) throw notFound(id)
  return { ...toSummary(row), drill: JSON.parse(row.data) as Drill }
}

export function createDrill(
  db: Db,
  input: { drill: unknown; origin: VersionOrigin; thumbnail?: string },
  now = Date.now(),
): DrillDetail {
  const drill = ensureValid(input.drill)
  const data = JSON.stringify(drill)
  const id = crypto.randomUUID()

  db.insert(drills)
    .values({
      id,
      title: drill.meta.title,
      category: drill.meta.category,
      source: drill.meta.source ?? null,
      data,
      thumbnail: checkThumbnail(input.thumbnail),
      createdAt: now,
      updatedAt: now,
    })
    .run()

  recordVersion(db, id, data, input.origin, now)
  return getDrill(db, id)
}

export function updateDrill(
  db: Db,
  id: string,
  input: { drill: unknown; origin: VersionOrigin; thumbnail?: string },
  now = Date.now(),
): DrillDetail {
  const existing = db.select().from(drills).where(eq(drills.id, id)).get()
  if (existing === undefined) throw notFound(id)

  const drill = ensureValid(input.drill)
  const data = JSON.stringify(drill)

  db.update(drills)
    .set({
      title: drill.meta.title,
      category: drill.meta.category,
      source: drill.meta.source ?? null,
      data,
      // 没传缩略图就保留原来的，避免编辑后列表图丢了
      thumbnail: input.thumbnail === undefined ? existing.thumbnail : checkThumbnail(input.thumbnail),
      updatedAt: now,
    })
    .where(eq(drills.id, id))
    .run()

  recordVersion(db, id, data, input.origin, now)
  return getDrill(db, id)
}

export function deleteDrill(db: Db, id: string): void {
  const existing = db.select({ id: drills.id }).from(drills).where(eq(drills.id, id)).get()
  if (existing === undefined) throw notFound(id)
  db.delete(drillVersions).where(eq(drillVersions.drillId, id)).run()
  db.delete(drills).where(eq(drills.id, id)).run()
}

/** 以已有训练为模板生成副本：新 id、标题加「副本」，改副本不影响原训练。 */
export function duplicateDrill(db: Db, id: string, now = Date.now()): DrillDetail {
  const source = getDrill(db, id)
  const copy: Drill = {
    ...source.drill,
    meta: { ...source.drill.meta, title: `${source.drill.meta.title} 副本` },
  }
  return createDrill(
    db,
    {
      drill: copy,
      origin: 'manual',
      ...(source.thumbnail === undefined ? {} : { thumbnail: source.thumbnail }),
    },
    now,
  )
}

export function listVersions(db: Db, id: string): VersionSummary[] {
  const exists = db.select({ id: drills.id }).from(drills).where(eq(drills.id, id)).get()
  if (exists === undefined) throw notFound(id)

  return db
    .select()
    .from(drillVersions)
    .where(eq(drillVersions.drillId, id))
    .orderBy(desc(drillVersions.createdAt), desc(drillVersions.id))
    .all()
    .map((row) => ({
      id: row.id,
      origin: row.origin as VersionOrigin,
      ...(row.restoredFrom === null ? {} : { restoredFrom: row.restoredFrom }),
      createdAt: row.createdAt,
    }))
}

/** 恢复到某个历史版本。这本身是一次新保存，不删历史（spec 第 5 节）。 */
export function restoreVersion(
  db: Db,
  id: string,
  versionId: number,
  now = Date.now(),
): DrillDetail {
  const version = db
    .select()
    .from(drillVersions)
    .where(and(eq(drillVersions.id, versionId), eq(drillVersions.drillId, id)))
    .get()
  if (version === undefined) {
    throw new LibraryError(`训练「${id}」下找不到版本 ${versionId}`, 404)
  }

  const drill = ensureValid(JSON.parse(version.data))
  const data = JSON.stringify(drill)

  db.update(drills)
    .set({
      title: drill.meta.title,
      category: drill.meta.category,
      source: drill.meta.source ?? null,
      data,
      updatedAt: now,
    })
    .where(eq(drills.id, id))
    .run()

  recordVersion(db, id, data, 'restore', now, versionId)
  return getDrill(db, id)
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT
  version: number
  exportedAt: string
  drills: Array<{ title: string; createdAt: number; drill: Drill }>
}

/** 不传 ids 就导出整个库。 */
export function exportDrills(db: Db, ids?: string[]): ExportFile {
  const rows = ids === undefined ? listDrills(db).map((s) => s.id) : ids
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    drills: rows.map((id) => {
      const detail = getDrill(db, id)
      return { title: detail.title, createdAt: detail.createdAt, drill: detail.drill }
    }),
  }
}

export interface ImportResult {
  imported: DrillSummary[]
  /** 逐条失败原因，一条坏数据不影响其他条导入。 */
  rejected: Array<{ index: number; title?: string; reason: string }>
}

/**
 * 导入。整个文件结构不对直接拒绝并说明原因；
 * 单条训练不合法只拒那一条。导入的训练一律分配新 id，不覆盖已有数据。
 */
export function importDrills(db: Db, payload: unknown, now = Date.now()): ImportResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new LibraryError('文件内容不是一个 JSON 对象', 400)
  }
  const file = payload as Partial<ExportFile>

  if (file.format !== EXPORT_FORMAT) {
    throw new LibraryError(
      `这不像本应用导出的训练库文件（缺少 format: "${EXPORT_FORMAT}"）`,
      400,
    )
  }
  if (typeof file.version !== 'number') {
    throw new LibraryError('文件缺少 version 字段，无法判断格式版本', 400)
  }
  if (file.version > EXPORT_VERSION) {
    throw new LibraryError(
      `文件格式版本是 ${file.version}，当前程序只认到 ${EXPORT_VERSION}。请升级应用后再导入。`,
      400,
    )
  }
  if (!Array.isArray(file.drills)) {
    throw new LibraryError('文件里没有 drills 数组', 400)
  }

  const imported: DrillSummary[] = []
  const rejected: ImportResult['rejected'] = []

  for (const [index, entry] of file.drills.entries()) {
    const title = typeof entry?.title === 'string' ? entry.title : undefined
    try {
      const detail = createDrill(db, { drill: entry?.drill, origin: 'import' }, now)
      imported.push(detail)
    } catch (error) {
      rejected.push({
        index,
        ...(title === undefined ? {} : { title }),
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { imported, rejected }
}
