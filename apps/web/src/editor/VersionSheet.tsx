import type { Drill } from '@drill/schema'
import { useEffect, useState } from 'react'
import { ApiError, listVersions, restoreVersion, type VersionSummary } from '../library/api.js'

interface Props {
  id: string
  /** 有未保存改动时要先警告：恢复会把编辑器里的内容整份换掉。 */
  dirty: boolean
  onClose: () => void
  onRestored: (drill: Drill) => void
}

/**
 * 版本历史。
 *
 * 每次保存/识别/改写服务端都留了一份快照，这里只做「看一眼 + 恢复」，
 * 不做版本间对比：手机屏上并排看两份 JSON 没有可用性。
 */
export function VersionSheet({ id, dirty, onClose, onRestored }: Props) {
  const [versions, setVersions] = useState<VersionSummary[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<number>()

  useEffect(() => {
    let cancelled = false
    listVersions(id)
      .then((list) => {
        if (!cancelled) setVersions(list)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const restore = async (versionId: number) => {
    if (dirty && !window.confirm('当前有未保存的修改，恢复会覆盖它们。继续？')) return
    setBusy(versionId)
    setError(undefined)
    try {
      const detail = await restoreVersion(id, versionId)
      onRestored(detail.drill)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex flex-col bg-neutral-950">
      <header className="flex shrink-0 items-center gap-2 px-3 pt-[max(10px,env(safe-area-inset-top))]">
        <h2 className="flex-1 text-sm font-semibold">版本历史</h2>
        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl bg-white/10 px-3 text-sm font-semibold"
        >
          关闭
        </button>
      </header>

      {error !== undefined && (
        <p className="mx-3 mt-2 shrink-0 rounded-xl bg-red-500/15 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 pb-[max(16px,env(safe-area-inset-bottom))]">
        {versions === undefined && error === undefined && (
          <p className="text-sm text-neutral-500">加载中…</p>
        )}
        {versions?.length === 0 && (
          <p className="text-sm text-neutral-500">还没有历史版本。每次保存都会留一份。</p>
        )}
        {versions?.map((version, index) => (
          <div
            key={version.id}
            className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {version.originLabel}
                {index === 0 && <span className="ml-2 text-[11px] text-emerald-400">最新</span>}
              </p>
              <p className="text-[11px] text-neutral-500">
                {formatTime(version.createdAt)}
                {version.restoredFrom !== undefined && ` · 由 #${version.restoredFrom} 恢复而来`}
              </p>
            </div>
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() => void restore(version.id)}
              className="h-11 shrink-0 rounded-xl bg-white/10 px-3 text-xs font-semibold disabled:text-neutral-600 active:bg-white/20"
            >
              {busy === version.id ? '恢复中' : '恢复'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
