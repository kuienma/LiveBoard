import { useCallback, useEffect, useRef, useState } from 'react'
import { loadBuiltInDrill } from '../drill.js'
import {
  ApiError,
  CATEGORY_LABEL,
  createDrill,
  deleteDrill,
  duplicateDrill,
  exportUrl,
  importFile,
  listDrills,
  type DrillSummary,
} from './api.js'
import { renderThumbnail } from './thumbnail.js'

interface Props {
  onOpen: (id: string) => void
  onUpload: () => void
}

export function LibraryPage({ onOpen, onUpload }: Props) {
  const [drills, setDrills] = useState<DrillSummary[]>([])
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const importRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    setError(undefined)
    try {
      setDrills(await listDrills({ q, category }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [q, category])

  // 搜索词变化时防抖，避免每敲一个字都打一次接口
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), q === '' ? 0 : 250)
    return () => clearTimeout(timer)
  }, [refresh, q])

  /** 库是空的时候给个入口，把内置示例塞进去，方便立刻看到东西。 */
  const seedExample = async () => {
    const loaded = loadBuiltInDrill()
    if (!loaded.ok) {
      setError(loaded.message)
      return
    }
    try {
      const thumbnail = renderThumbnail(loaded.drill)
      const created = await createDrill({
        drill: loaded.drill,
        origin: 'manual',
        ...(thumbnail === undefined ? {} : { thumbnail }),
      })
      onOpen(created.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const remove = async (drill: DrillSummary) => {
    if (!window.confirm(`删除「${drill.title}」？删除后无法恢复。`)) return
    try {
      await deleteDrill(drill.id)
      setNotice(`已删除「${drill.title}」`)
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const duplicate = async (drill: DrillSummary) => {
    try {
      const copy = await duplicateDrill(drill.id)
      setNotice(`已复制为「${copy.title}」`)
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const doImport = async (file: File | undefined) => {
    if (file === undefined) return
    setError(undefined)
    try {
      const result = await importFile(file)
      const parts = [`导入 ${result.imported.length} 个训练`]
      if (result.rejected.length > 0) {
        parts.push(
          `${result.rejected.length} 个被拒绝：` +
            result.rejected
              .map((r) => `${r.title ?? `第 ${r.index + 1} 条`}（${firstIssue(r.reason)}）`)
              .join('；'),
        )
      }
      setNotice(parts.join('，'))
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const categories = [...new Set(drills.map((d) => d.category))]
  const empty = !loading && drills.length === 0 && q === '' && category === ''

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 px-4 pt-[max(12px,env(safe-area-inset-top))]">
        <h1 className="flex-1 text-lg font-semibold">训练库</h1>
        <button
          type="button"
          onClick={onUpload}
          className="h-11 shrink-0 rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-neutral-950 active:bg-emerald-400"
        >
          拍书页
        </button>
      </header>

      {!empty && (
        <div className="shrink-0 space-y-2 px-4 pt-3">
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.currentTarget.value)}
            placeholder="搜索标题"
            className="h-11 w-full rounded-xl bg-white/10 px-3 text-sm outline-none placeholder:text-neutral-500 focus:bg-white/15"
          />
          {categories.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              <FilterChip active={category === ''} onClick={() => setCategory('')}>
                全部
              </FilterChip>
              {categories.map((value) => (
                <FilterChip
                  key={value}
                  active={category === value}
                  onClick={() => setCategory(category === value ? '' : value)}
                >
                  {CATEGORY_LABEL[value] ?? value}
                </FilterChip>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error !== undefined && (
          <p className="mb-3 whitespace-pre-wrap rounded-xl bg-red-500/15 px-3 py-2 text-xs leading-relaxed text-red-300">
            {error}
          </p>
        )}
        {notice !== undefined && (
          <p className="mb-3 rounded-xl bg-emerald-500/10 px-3 py-2 text-xs leading-relaxed text-emerald-200">
            {notice}
          </p>
        )}

        {loading && <p className="py-8 text-center text-sm text-neutral-500">加载中…</p>}

        {empty && (
          <div className="space-y-4 py-10 text-center">
            <p className="text-sm text-neutral-400">训练库还是空的。</p>
            <button
              type="button"
              onClick={onUpload}
              className="h-14 w-full rounded-2xl bg-emerald-500 text-base font-semibold text-neutral-950 active:bg-emerald-400"
            >
              拍一页训练书
            </button>
            <button
              type="button"
              onClick={() => void seedExample()}
              className="h-12 w-full rounded-2xl bg-white/10 text-sm font-semibold active:bg-white/20"
            >
              先看内置示例（从侧边进攻）
            </button>
          </div>
        )}

        {!loading && !empty && drills.length === 0 && (
          <p className="py-8 text-center text-sm text-neutral-500">没有匹配的训练。</p>
        )}

        <ul className="space-y-3">
          {drills.map((drill) => (
            <li key={drill.id} className="overflow-hidden rounded-2xl bg-white/5">
              <button
                type="button"
                onClick={() => onOpen(drill.id)}
                className="flex w-full items-center gap-3 p-3 text-left active:bg-white/10"
              >
                {drill.thumbnail === undefined ? (
                  <div className="h-16 w-[86px] shrink-0 rounded-xl bg-white/10" />
                ) : (
                  <img
                    src={drill.thumbnail}
                    alt=""
                    className="h-16 w-[86px] shrink-0 rounded-xl object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{drill.title}</p>
                  <p className="mt-0.5 truncate text-xs text-neutral-400">
                    {/* 出处里通常已含章节名（含类别），有出处就不再重复显示类别 */}
                    {drill.variantCount} 个练法 ·{' '}
                    {drill.source ?? CATEGORY_LABEL[drill.category] ?? drill.category}
                  </p>
                  <p className="mt-0.5 text-[11px] text-neutral-500">
                    更新于 {formatTime(drill.updatedAt)}
                  </p>
                </div>
              </button>
              <div className="flex border-t border-white/5">
                <CardAction onClick={() => void duplicate(drill)}>复制</CardAction>
                <a
                  href={exportUrl([drill.id])}
                  download
                  className="flex h-11 flex-1 items-center justify-center border-l border-white/5 text-xs text-neutral-300 active:bg-white/10"
                >
                  导出
                </a>
                <CardAction onClick={() => void remove(drill)} danger>
                  删除
                </CardAction>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="shrink-0 space-y-2 border-t border-white/5 px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <div className="flex gap-2">
          <a
            href={exportUrl()}
            download
            className="flex h-11 flex-1 items-center justify-center rounded-xl bg-white/10 text-sm font-semibold active:bg-white/20"
          >
            导出全部备份
          </a>
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            className="h-11 flex-1 rounded-xl bg-white/10 text-sm font-semibold active:bg-white/20"
          >
            导入 JSON
          </button>
        </div>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            void doImport(event.currentTarget.files?.[0])
            event.currentTarget.value = ''
          }}
        />
        <p className="text-[11px] leading-relaxed text-neutral-500">
          训练存在后端的 SQLite 里。第一版没有账号，建议定期「导出全部备份」，
          换机器或重装时可以导回来。
        </p>
      </div>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'h-9 shrink-0 rounded-full px-3 text-xs font-semibold transition-colors',
        active ? 'bg-emerald-500 text-neutral-950' : 'bg-white/10 text-neutral-300',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function CardAction({
  onClick,
  danger = false,
  children,
}: {
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'h-11 flex-1 text-xs active:bg-white/10',
        danger ? 'border-l border-white/5 text-red-300' : 'text-neutral-300',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/**
 * 后端的校验错误是「训练数据未通过校验：\n- 路径：原因」这种多行文本。
 * 列表提示里只有一行空间，取第一条具体问题，而不是那句没信息量的开头。
 */
function firstIssue(reason: string): string {
  const lines = reason
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const issue = lines.find((line) => line.startsWith('-'))
  return (issue ?? lines[0] ?? reason).replace(/^-\s*/, '')
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()

  return sameDay
    ? `今天 ${date.toTimeString().slice(0, 5)}`
    : `${date.getMonth() + 1}月${date.getDate()}日`
}
