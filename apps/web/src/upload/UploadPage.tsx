import type { Drill } from '@drill/schema'
import { useCallback, useEffect, useRef, useState } from 'react'
import { compressPage, type CompressedPage } from './compressPage.js'
import {
  PHASE_LABEL,
  recognizePages,
  type RecognizeOutcome,
  type RecognizePhase,
} from './recognizeClient.js'

interface Props {
  /** 用户确认识别结果后存进训练库。保存可能失败（后端没起），所以是异步的。 */
  onConfirm: (drill: Drill) => Promise<void>
  onCancel: () => void
}

type Stage =
  | { kind: 'picking' }
  | { kind: 'working'; phase: RecognizePhase }
  | { kind: 'done'; outcome: RecognizeOutcome }

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.round(bytes / 1024)}KB`
}

export function UploadPage({ onConfirm, onCancel }: Props) {
  const [pages, setPages] = useState<CompressedPage[]>([])
  const [stage, setStage] = useState<Stage>({ kind: 'picking' })
  const [pickError, setPickError] = useState<string>()
  const cameraRef = useRef<HTMLInputElement | null>(null)
  const albumRef = useRef<HTMLInputElement | null>(null)

  // 缩略图的 blob URL 要回收，否则反复选图会漏内存。
  // 注意不能把 pages 放进依赖：那样每次增删都会回收上一份数组里的 URL，
  // 而它们多数还在新数组里继续显示，缩略图会变成裂图。只在卸载时清。
  const pagesRef = useRef<CompressedPage[]>([])
  pagesRef.current = pages
  useEffect(
    () => () => {
      for (const page of pagesRef.current) URL.revokeObjectURL(page.previewUrl)
    },
    [],
  )

  const addFiles = useCallback(async (files: FileList | null) => {
    if (files === null || files.length === 0) return
    setPickError(undefined)
    try {
      const compressed = await Promise.all([...files].map(compressPage))
      setPages((current) => [...current, ...compressed].slice(0, 6))
    } catch (error) {
      setPickError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const removePage = (index: number) => {
    setPages((current) => {
      const page = current[index]
      if (page !== undefined) URL.revokeObjectURL(page.previewUrl)
      return current.filter((_, i) => i !== index)
    })
  }

  /** 回到选图界面并清空已选照片。识别失败后如果不清，下一次会把旧照片一起传上去。 */
  const startOver = () => {
    for (const page of pagesRef.current) URL.revokeObjectURL(page.previewUrl)
    setPages([])
    setPickError(undefined)
    setStage({ kind: 'picking' })
  }

  const start = async () => {
    if (pages.length === 0) return
    setStage({ kind: 'working', phase: { kind: 'uploading' } })
    try {
      const outcome = await recognizePages(
        pages.map((page) => page.file),
        (phase) => setStage({ kind: 'working', phase }),
      )
      setStage({ kind: 'done', outcome })
    } catch (error) {
      setStage({
        kind: 'done',
        outcome: {
          ok: false,
          kind: 'request_failed',
          message:
            error instanceof Error
              ? `请求失败：${error.message}。确认后端已启动（pnpm dev:api）。`
              : String(error),
        },
      })
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex shrink-0 items-center gap-3 px-4 pt-[max(12px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onCancel}
          className="h-11 shrink-0 rounded-xl bg-white/10 px-3 text-sm font-semibold active:bg-white/20"
        >
          返回
        </button>
        <h1 className="text-base font-semibold">拍摄训练书页</h1>
      </header>

      <div className="flex-1 space-y-4 px-4 py-4">
        {stage.kind === 'picking' && (
          <>
            <p className="text-xs leading-relaxed text-neutral-400">
              对准书上的训练图和文字说明拍照。文字说明很重要——训练规则和「变化」通常只写在文字里。
              一个训练跨两页时可以分别拍，最多 6 页。
            </p>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                className="h-14 rounded-2xl bg-emerald-500 text-sm font-semibold text-neutral-950 active:bg-emerald-400"
              >
                拍照
              </button>
              <button
                type="button"
                onClick={() => albumRef.current?.click()}
                className="h-14 rounded-2xl bg-white/10 text-sm font-semibold active:bg-white/20"
              >
                从相册选
              </button>
            </div>

            {/* capture=environment 让手机直接调后置相机 */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => void addFiles(event.currentTarget.files)}
            />
            <input
              ref={albumRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => void addFiles(event.currentTarget.files)}
            />

            {pickError !== undefined && (
              <p className="rounded-xl bg-red-500/15 px-3 py-2 text-xs text-red-300">{pickError}</p>
            )}

            {pages.length > 0 && (
              <>
                <ul className="space-y-2">
                  {pages.map((page, index) => (
                    <li
                      key={page.previewUrl}
                      className="flex items-center gap-3 rounded-2xl bg-white/5 p-2"
                    >
                      <img
                        src={page.previewUrl}
                        alt={`第 ${index + 1} 页`}
                        className="h-16 w-16 shrink-0 rounded-xl object-cover"
                      />
                      <div className="min-w-0 flex-1 text-xs text-neutral-400">
                        <p className="font-semibold text-neutral-200">第 {index + 1} 页</p>
                        <p>
                          {page.width}×{page.height}，{formatBytes(page.file.size)}
                          {page.originalBytes > page.file.size * 1.5 && (
                            <>（原 {formatBytes(page.originalBytes)}）</>
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePage(index)}
                        className="h-11 shrink-0 rounded-xl px-3 text-xs text-neutral-400 active:bg-white/10"
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  onClick={() => void start()}
                  className="h-14 w-full rounded-2xl bg-emerald-500 text-base font-semibold text-neutral-950 active:bg-emerald-400"
                >
                  开始识别（{pages.length} 页）
                </button>
                <p className="text-center text-[11px] text-neutral-500">
                  识别通常需要半分钟左右，期间请不要关闭页面
                </p>
              </>
            )}
          </>
        )}

        {stage.kind === 'working' && <Working phase={stage.phase} />}

        {stage.kind === 'done' && (
          <Result outcome={stage.outcome} onConfirm={onConfirm} onRetry={startOver} />
        )}
      </div>
    </div>
  )
}

function Working({ phase }: { phase: RecognizePhase }) {
  const label = PHASE_LABEL[phase.kind]
  const detail =
    phase.kind === 'requesting' && phase.attempt > 1
      ? `第 ${phase.attempt} 次尝试`
      : phase.kind === 'retrying'
        ? `上一次的数据有 ${phase.issueCount} 处问题，已把问题发回模型`
        : phase.kind === 'received'
          ? `${phase.pages} 页已上传`
          : undefined

  return (
    <div className="space-y-4 py-8 text-center">
      <div
        className="mx-auto h-10 w-10 animate-spin rounded-full border-[3px] border-white/15 border-t-emerald-400"
        role="status"
        aria-label={label}
      />
      <p className="text-base font-semibold">{label}…</p>
      {detail !== undefined && <p className="text-xs text-neutral-400">{detail}</p>}
      <p className="text-[11px] leading-relaxed text-neutral-500">
        识别结果不会 100% 准确，下一步你可以先看模型的理解说明再决定是否采用
      </p>
    </div>
  )
}

function Result({
  outcome,
  onConfirm,
  onRetry,
}: {
  outcome: RecognizeOutcome
  onConfirm: (drill: Drill) => Promise<void>
  onRetry: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()

  const save = async (drill: Drill) => {
    setSaving(true)
    setSaveError(undefined)
    try {
      await onConfirm(drill)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  if (!outcome.ok) {
    // 「不是训练图」是用户拍错了，不该像报错一样红着脸；其余才是真出问题
    const mistake = outcome.kind === 'not_recognizable'
    return (
      <div className="space-y-4">
        <div className={`rounded-2xl p-4 ${mistake ? 'bg-amber-400/10' : 'bg-red-500/15'}`}>
          <h2
            className={`text-sm font-semibold ${mistake ? 'text-amber-300' : 'text-red-300'}`}
          >
            {mistake ? '这一页看起来不是训练图' : '识别没有成功'}
          </h2>
          <p
            className={`mt-2 text-xs leading-relaxed ${mistake ? 'text-amber-200/90' : 'text-red-200/90'}`}
          >
            {outcome.message}
          </p>
        </div>
        {outcome.issues !== undefined && (
          <details className="rounded-2xl bg-white/5 p-3">
            <summary className="cursor-pointer text-xs font-semibold text-neutral-300">
              查看校验问题（给开发看的）
            </summary>
            <pre className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-400">
              {outcome.issues}
            </pre>
          </details>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="h-14 w-full rounded-2xl bg-emerald-500 text-base font-semibold text-neutral-950 active:bg-emerald-400"
        >
          重新拍照
        </button>
      </div>
    )
  }

  const { drill, understanding, uncertainties, meta } = outcome

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-emerald-500/10 p-4">
        <h2 className="text-sm font-semibold text-emerald-300">识别完成</h2>
        <p className="mt-1 text-xs text-emerald-200/80">
          {drill.meta.title} · {drill.variants.length} 个练法 · 场地 {drill.field.width}×
          {drill.field.height} 米
        </p>
      </div>

      <section>
        <h3 className="text-sm font-semibold">模型的理解</h3>
        <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-white/5 p-3 text-xs leading-relaxed text-neutral-300">
          {understanding === '' ? '(模型没有给出说明)' : understanding}
        </p>
      </section>

      <section>
        <h3 className="text-sm font-semibold">
          不确定的地方
          {uncertainties.length > 0 && (
            <span className="ml-1 text-xs font-normal text-neutral-500">
              （{uncertainties.length} 处）
            </span>
          )}
        </h3>
        {uncertainties.length === 0 ? (
          <p className="mt-2 text-xs text-neutral-500">
            模型没有提出不确定点。书页有歧义时这通常不是好信号，建议自己核对一遍。
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {uncertainties.map((item) => (
              <li
                key={item}
                className="rounded-xl bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-200/90"
              >
                {item}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ul className="space-y-1 text-xs text-neutral-400">
        {drill.variants.map((variant) => (
          <li key={variant.id}>
            <span className="font-semibold text-neutral-200">{variant.name}</span>
            ：{variant.phases.length} 个阶段 × {variant.repeat?.times ?? 1} 轮
            {variant.description === undefined ? '' : ` — ${variant.description}`}
          </li>
        ))}
      </ul>

      {saveError !== undefined && (
        <p className="whitespace-pre-wrap rounded-xl bg-red-500/15 px-3 py-2 text-xs leading-relaxed text-red-300">
          保存失败：{saveError}
        </p>
      )}

      <div className="space-y-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save(drill)}
          className="h-14 w-full rounded-2xl bg-emerald-500 text-base font-semibold text-neutral-950 active:bg-emerald-400 disabled:opacity-60"
        >
          {saving ? '保存中…' : '存入训练库并看动画'}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="h-12 w-full rounded-2xl bg-white/10 text-sm font-semibold active:bg-white/20"
        >
          换一张重新识别
        </button>
      </div>

      <p className="pb-4 text-center text-[11px] text-neutral-500">
        {meta.model} · {meta.attempts} 次尝试 · {meta.usage.inputTokens}+
        {meta.usage.outputTokens} tokens
      </p>
    </div>
  )
}
