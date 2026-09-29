import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>

/**
 * 建表语句直接在启动时跑一遍 IF NOT EXISTS，没有引入 drizzle-kit 迁移文件。
 *
 * 取舍：现在只有两张表、字段也稳定，迁移文件带来的仪式感大于价值；
 * 等 schema 真的开始演进（比如加账号、加共享）再引入 drizzle-kit。
 * 注意这只管数据库表结构，Drill JSON 自身的 version 迁移是另一回事（见 import 时的处理）。
 */
const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS drills (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT,
    data TEXT NOT NULL,
    thumbnail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS drills_category_idx ON drills (category)`,
  `CREATE INDEX IF NOT EXISTS drills_updated_idx ON drills (updated_at)`,
  `CREATE TABLE IF NOT EXISTS drill_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drill_id TEXT NOT NULL,
    data TEXT NOT NULL,
    origin TEXT NOT NULL,
    restored_from INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS versions_drill_idx ON drill_versions (drill_id, created_at)`,
]

/**
 * 打开数据库。路径传 ':memory:' 用于测试。
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const sqlite = new Database(path)
  // WAL 让读写不互相阻塞；外键约束默认是关的，显式打开
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  for (const statement of CREATE_STATEMENTS) {
    sqlite.exec(statement)
  }

  return drizzle(sqlite, { schema })
}

export * from './schema.js'
