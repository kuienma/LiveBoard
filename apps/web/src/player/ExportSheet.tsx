import type { Drill } from '@drill/schema'
import { useEffect, useRef, useState } from 'react'
import {
  ApiError,
  cancelExport,
  createExport,
  exportVideoUrl,
  getExport,
  getHealth,
  stillPngUrl,
  type ExportTask,
  type Orientation,
} from '../library/api.js'

interface Props {
  drillId: string
  drill: Drill
  /** 打开导出面板时正在看的练法，默认勾上它。 */
  currentVariantId: string
  onClose: () => void
}

/** 轮询间隔。渲染一帧远快于这个间隔，进度条看起来是连续的。 */
const POLL_MS = 400

/**
 * 导出面板：选练法、选横竖屏，然后排队渲染 MP4；也可以直接存 PNG。
 *
 * 轮询而不是 SSE：导出可能要几十秒，手机上息屏或切走再回来时
 * 轮询能自己接上，SSE 断了就什么都不剩了。
 */
export function ExportSheet({ drillId, drill, currentVariantId, onClose }: Props) {
  const [orientation, setOrientation] = useState<Orientation>('landscape')
  const [selected, setSelected] = useState<string[]>([currentVariantId])
  const [showNarration, setShowNarration] = useState(true)
  const [voiceOver, setVoiceOver] = useState(false)
  /** 服务端没配语音合成时不显示这个开关，免得勾了却拿到无声视频。 */
  const [canVoiceOver, setCanVoiceOver] = useState(false)
  const [task, setTask] = useState<ExportTask>()
  const [error, setError] = useState<string>()
  const [starting, setStarting] = useState(false)

  // 轮询在任务结束时必须停掉，否则切到后台回来还在打接口
  const taskIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (task === undefined || task.status === 'queued' || task.status === 'running') {
      if (task === undefined) return
      taskIdRef.current = task.id
      const timer = setTimeout(() => {
        getExport(task.id)
          .then(setTask)
          .catch((cause: unknown) => {
            setError(cause instanceof ApiError ? cause.message : String(cause))
          })
      }, POLL_MS)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [task])

  useEffect(() => {
    let cancelled = false
    getHealth()
      .then((health) => {
        if (!cancelled) setCanVoiceOver(health.voiceOver === true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const toggleVariant = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  const start = async () => {
    setStarting(true)
    setError(undefined)
    try {
      setTask(
        await createExport({
          drillId,
          orientation,
          variantIds: selected,
          showNarration,
          voiceOver,
        }),
      )
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause))
    } finally {
      setStarting(false)
    }
  }

  const stop = async () => {
    const id = taskIdRef.current
    if (id === undefined) return
    try {
      await cancelExport(id)
      setTask(await getExport(id))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause))
    }
  }

  const running = task?.status === 'queued' || task?.status === 'running'
  const percent = task === undefined || task.total === 0 ? 0 : (task.done / task.total) * 100

  return (
    <div className="fixed inset-0 z-10 flex flex-col bg-neutral-950">
      <header className="flex shrink-0 items-center gap-2 px-3 pt-[max(10px,env(safe-area-inset-top))]">
        <h2 className="flex-1 text-sm font-semibold">导出</h2>
        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl bg-white/10 px-3 text-sm font-semibold"
        >
          关闭
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3 pb-[max(16px,env(safe-area-inset-bottom))]">
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-neutral-400">练法（按顺序拼进一个视频）</h3>
          {drill.variants.map((variant) => (
            <label
              key={variant.id}
              className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5 text-sm"
            >
              <input
                type="checkbox"
                checked={selected.includes(variant.id)}
                onChange={() => toggleVariant(variant.id)}
                disabled={running}
                className="h-5 w-5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">{variant.name}</span>
              <a
                href={stillPngUrl(drillId, variant.id, orientation)}
                download
                className="h-9 shrink-0 rounded-lg bg-white/10 px-2.5 text-xs font-semibold leading-9 active:bg-white/20"
              >
                存 PNG
              </a>
            </label>
          ))}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-neutral-400">画面</h3>
          <div className="flex gap-2">
            {(
              [
                ['landscape', '横屏 1920×1080'],
                ['portrait', '竖屏 1080×1920'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={running}
                onClick={() => setOrientation(value)}
                className={[
                  'h-11 flex-1 rounded-xl text-xs font-semibold disabled:opacity-50',
                  orientation === value
                    ? 'bg-emerald-500 text-neutral-950'
                    : 'bg-white/10 text-neutral-300',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex h-11 items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={showNarration}
              onChange={(event) => setShowNarration(event.currentTarget.checked)}
              disabled={running}
              className="h-5 w-5"
            />
            画面上叠加中文说明
          </label>
          {canVoiceOver && (
            <label className="flex min-h-11 items-center gap-2 py-1 text-xs text-neutral-300">
              <input
                type="checkbox"
                checked={voiceOver}
                onChange={(event) => setVoiceOver(event.currentTarget.checked)}
                disabled={running}
                className="h-5 w-5 shrink-0"
              />
              <span>加中文配音（每轮念一句说明，会多花十几秒）</span>
            </label>
          )}
        </section>

        {error !== undefined && (
          <p className="rounded-xl bg-red-500/15 px-3 py-2 text-xs text-red-300">{error}</p>
        )}

        {task !== undefined && (
          <section className="space-y-2 rounded-xl bg-white/5 p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold">{STATUS_LABEL[task.status]}</span>
              <span className="text-neutral-500">
                {task.total === 0 ? '' : `${task.done} / ${task.total} 帧`}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-emerald-500 transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
            {task.narration !== undefined && task.narration !== '未开启配音' && (
              <p className="text-[11px] leading-relaxed text-neutral-400">{task.narration}</p>
            )}
            {task.message !== undefined && (
              <p className="text-[11px] leading-relaxed text-red-300">{task.message}</p>
            )}
            {task.ready && (
              <>
                <a
                  href={exportVideoUrl(task.id)}
                  download={task.fileName}
                  className="block h-11 rounded-xl bg-emerald-500 text-center text-sm font-semibold leading-[44px] text-neutral-950"
                >
                  下载 MP4{task.bytes === undefined ? '' : `（${formatSize(task.bytes)}）`}
                </a>
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  时长 {task.durationSeconds ?? 0} 秒。iPhone 在下载后的预览里点分享即可存到相册；
                  安卓浏览器会存到「下载」目录。文件在服务器上只保留 1 小时。
                </p>
              </>
            )}
          </section>
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        {running ? (
          <button
            type="button"
            onClick={() => void stop()}
            className="h-12 w-full rounded-xl bg-red-500/20 text-sm font-semibold text-red-300"
          >
            取消导出
          </button>
        ) : (
          <button
            type="button"
            disabled={selected.length === 0 || starting}
            onClick={() => void start()}
            className="h-12 w-full rounded-xl bg-emerald-500 text-sm font-semibold text-neutral-950 disabled:bg-white/10 disabled:text-neutral-500"
          >
            {selected.length === 0
              ? '先选至少一个练法'
              : starting
                ? '提交中…'
                : `生成 MP4（${selected.length} 个练法）`}
          </button>
        )}
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<ExportTask['status'], string> = {
  queued: '排队中…',
  running: '渲染中…',
  done: '已完成',
  failed: '导出失败',
  cancelled: '已取消',
}

function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}
