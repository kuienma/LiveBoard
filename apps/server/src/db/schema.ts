import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 训练库。
 *
 * Drill JSON 整份存在 `data` 里（文本），title / category / source 冗余一份出来
 * 只为了列表页能筛选和搜索，不必反序列化每一条。真值始终是 `data`。
 */
export const drills = sqliteTable(
  'drills',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    source: text('source'),
    /** 完整的 Drill JSON。 */
    data: text('data').notNull(),
    /** 列表页缩略图，前端用 drill-render 画好后传上来的 data URL。 */
    thumbnail: text('thumbnail'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('drills_category_idx').on(table.category),
    index('drills_updated_idx').on(table.updatedAt),
  ],
)

/** 版本来源，用于在历史里显示「这一版是怎么来的」。 */
export const VERSION_ORIGINS = ['recognition', 'manual', 'ai-revise', 'import', 'restore'] as const
export type VersionOrigin = (typeof VERSION_ORIGINS)[number]

export const ORIGIN_LABEL: Record<VersionOrigin, string> = {
  recognition: 'AI 识别',
  manual: '手动编辑',
  'ai-revise': 'AI 修改',
  import: '导入',
  restore: '恢复历史版本',
}

/**
 * 版本记录。每次保存生成一条（docs/spec.md 第 4.5 节），每个训练至少保留最近 20 条。
 * 恢复历史版本也算一次新保存，不删历史。
 */
export const drillVersions = sqliteTable(
  'drill_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    drillId: text('drill_id').notNull(),
    data: text('data').notNull(),
    origin: text('origin').notNull(),
    /** restore 时记录来源版本，便于在历史里说明「恢复自第 N 版」。 */
    restoredFrom: integer('restored_from'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('versions_drill_idx').on(table.drillId, table.createdAt)],
)

/** 每个训练保留的版本数上限（spec 要求至少 20）。 */
export const MAX_VERSIONS_PER_DRILL = 20
