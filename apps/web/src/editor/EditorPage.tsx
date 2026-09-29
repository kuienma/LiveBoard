import { compileVariant, sampleTimeline, type Timeline } from '@drill/engine'
import { formatIssues, parseDrill, type Drill, type Vec2 } from '@drill/schema'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ApiError, getDrill, updateDrill } from '../library/api.js'
import { renderThumbnail } from '../library/thumbnail.js'
import { EditorCanvas } from './EditorCanvas.js'
import { canRedo, canUndo, editorReducer, initEditor, isDirty } from './editorState.js'
import { buildHandles, keyframeTime, type Handle, type Keyframe } from './handles.js'
import { InspectorPanel } from './InspectorPanel.js'
import { VersionSheet } from './VersionSheet.js'

interface Props {
  id: string
  onDone: (id: string) => void
}

export function EditorPage({ id, onDone }: Props) {
  const [baseline, setBaseline] = useState<Drill>()
  const [loadError, setLoadError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    getDrill(id)
      .then((detail) => {
        if (!cancelled) setBaseline(detail.drill)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof ApiError ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (loadError !== undefined) {
    return (
      <div className="flex h-full flex-col gap-4 p-4">
        <button
          type="button"
          onClick={() => onDone(id)}
          className="h-11 self-start rounded-xl bg-white/10 px-3 text-sm font-semibold"
        >
          返回
        </button>
        <p className="rounded-xl bg-red-500/15 p-3 text-xs text-red-300">{loadError}</p>
      </div>
    )
  }

  if (baseline === undefined) {
    return <p className="flex h-full items-center justify-center text-sm text-neutral-500">加载中…</p>
  }

  return <Editor key={id} id={id} baseline={baseline} onSaved={setBaseline} onDone={onDone} />
}

function Editor({
  id,
  baseline,
  onSaved,
  onDone,
}: {
  id: string
  baseline: Drill
  onSaved: (drill: Drill) => void
  onDone: (id: string) => void
}) {
  const [state, dispatch] = useReducer(editorReducer, baseline, initEditor)
  const [variantId, setVariantId] = useState(baseline.variants[0]?.id ?? '')
  const [keyframe, setKeyframe] = useState<Keyframe>({ kind: 'setup' })
  const [selectedKey, setSelectedKey] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [showJson, setShowJson] = useState(false)
  const [showVersions, setShowVersions] = useState(false)

  const dirty = isDirty(state, baseline)

  /**
   * 换关键帧时把属性面板滚回顶部：面板顶部就是当前阶段的编辑区，
   * 沿用上一次的滚动位置会让人以为这个阶段没有可编辑的东西。
   */
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 })
  }, [keyframe, variantId])

  // 离开前提醒未保存（手机上误触返回很常见）
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  /** 每次改动都过同一套校验，不合法就不让保存（阶段三验收项）。 */
  const validation = useMemo(() => parseDrill(state.drill), [state.drill])

  /**
   * 编译当前练法用于预览。数据不合法时编译可能抛错，
   * 这时保留上一次能用的时间线，让画面停在最后一个有效状态而不是白屏。
   */
  const lastGood = useRef<Timeline | undefined>(undefined)
  const timeline = useMemo(() => {
    if (!validation.ok) return lastGood.current
    const variant = validation.drill.variants.find((item) => item.id === variantId)
    if (variant === undefined) return lastGood.current
    try {
      lastGood.current = compileVariant(validation.drill, variant.id)
    } catch {
      // 落到上一份可用的时间线
    }
    return lastGood.current
  }, [validation, variantId])

  const variant = state.drill.variants.find((item) => item.id === variantId)

  /**
   * 手柄在这里统一构建，画布和属性面板共用同一份。
   * 面板只存 selectedKey：早先存整个 handle 快照，撤销后面板里的坐标还是旧值。
   */
  const view = useMemo(() => {
    if (timeline === undefined) return undefined
    const frame = sampleTimeline(timeline, keyframeTime(timeline, keyframe))
    return { frame, handles: buildHandles(state.drill, variantId, keyframe, frame) }
  }, [state.drill, timeline, variantId, keyframe])
  const selected = view?.handles.find((handle) => handle.key === selectedKey)

  const save = async () => {
    if (!validation.ok) return
    setSaving(true)
    setSaveError(undefined)
    try {
      const thumbnail = renderThumbnail(validation.drill)
      await updateDrill(id, {
        drill: validation.drill,
        origin: 'manual',
        ...(thumbnail === undefined ? {} : { thumbnail }),
      })
      onSaved(validation.drill)
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const onDrag = (handle: Handle, pos: Vec2) => {
    const target = handle.target
    if (target === undefined) return

    if (target.kind === 'object') {
      dispatch({ type: 'moveObject', id: target.id, pos })
      return
    }
    if (target.kind === 'setup') {
      dispatch({ type: 'moveSetup', variantId, actorId: target.actorId, pos })
      return
    }
    dispatch({
      type: 'moveActionTarget',
      variantId,
      phaseIndex: target.phaseIndex,
      actionIndex: target.actionIndex,
      pos,
    })
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-1.5 px-3 pt-[max(10px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={() => {
            if (dirty && !window.confirm('有未保存的修改，确定离开？')) return
            onDone(id)
          }}
          aria-label="返回"
          className="h-11 w-11 shrink-0 rounded-xl bg-white/10 active:bg-white/20"
        >
          ‹
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">编辑：{state.drill.meta.title}</h1>
        <IconButton disabled={!canUndo(state)} onClick={() => dispatch({ type: 'undo' })} label="撤销">
          ↶
        </IconButton>
        <IconButton disabled={!canRedo(state)} onClick={() => dispatch({ type: 'redo' })} label="重做">
          ↷
        </IconButton>
        <button
          type="button"
          disabled={!dirty || !validation.ok || saving}
          onClick={() => void save()}
          className="h-11 shrink-0 rounded-xl bg-emerald-500 px-3 text-sm font-semibold text-neutral-950 disabled:bg-white/10 disabled:text-neutral-500"
        >
          {saving ? '保存中' : dirty ? '保存' : '已保存'}
        </button>
      </header>

      {/* 练法切换 */}
      <div className="flex shrink-0 gap-2 overflow-x-auto px-3 pt-2">
        {state.drill.variants.map((item) => (
          <Chip
            key={item.id}
            active={item.id === variantId}
            onClick={() => {
              setVariantId(item.id)
              setKeyframe({ kind: 'setup' })
              setSelectedKey(undefined)
            }}
          >
            {item.name}
          </Chip>
        ))}
      </div>

      {/* 关键帧选择 */}
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto px-3 pt-2">
        <span className="shrink-0 text-[11px] text-neutral-500">关键帧</span>
        <Chip
          active={keyframe.kind === 'setup'}
          onClick={() => {
            setKeyframe({ kind: 'setup' })
            setSelectedKey(undefined)
          }}
        >
          起始站位
        </Chip>
        {variant?.phases.map((_phase, index) => (
          <Chip
            key={index}
            active={keyframe.kind === 'phase' && keyframe.index === index}
            onClick={() => {
              setKeyframe({ kind: 'phase', index })
              setSelectedKey(undefined)
            }}
          >
            阶段 {index + 1}
          </Chip>
        ))}
      </div>

      {/* 画布：固定按场地比例给高度，剩下的留给属性面板 */}
      <div className="mt-2 shrink-0 px-1" style={{ height: 'min(46vh, 340px)' }}>
        {view === undefined ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-xs text-neutral-500">
            数据当前不合法，无法预览。修好下面列出的问题后画面会回来。
          </p>
        ) : (
          <EditorCanvas
            frame={view.frame}
            handles={view.handles}
            {...(selectedKey === undefined ? {} : { selectedKey })}
            onSelect={(handle) => setSelectedKey(handle.key)}
            onDrag={onDrag}
            onDragEnd={() => dispatch({ type: 'endDrag' })}
          />
        )}
      </div>

      {!validation.ok && (
        <details className="mx-3 mt-2 shrink-0 rounded-xl bg-red-500/15 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-red-300">
            {validation.issues.length} 处问题，保存已锁定
          </summary>
          <pre className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-red-200/90">
            {formatIssues(validation.issues)}
          </pre>
        </details>
      )}

      {saveError !== undefined && (
        <p className="mx-3 mt-2 shrink-0 rounded-xl bg-red-500/15 px-3 py-2 text-xs text-red-300">
          保存失败：{saveError}
        </p>
      )}

      {state.lastRejection !== undefined && (
        <p className="mx-3 mt-2 shrink-0 rounded-xl bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
          {state.lastRejection.reason === 'toward'
            ? '这一步的终点是运行时算出来的，不能直接拖。'
            : '这个位置的基准点会移动，不能直接拖。'}
        </p>
      )}

      <div
        ref={panelRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-3"
      >
        <InspectorPanel
          drill={state.drill}
          variantId={variantId}
          keyframe={keyframe}
          {...(selected === undefined ? {} : { selected })}
          dispatch={dispatch}
          onSelectPhase={(index) => setKeyframe({ kind: 'phase', index })}
        />

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setShowVersions(true)}
            className="h-11 rounded-xl bg-white/5 text-xs text-neutral-400 active:bg-white/10"
          >
            版本历史
          </button>
          <button
            type="button"
            onClick={() => setShowJson(true)}
            className="h-11 rounded-xl bg-white/5 text-xs text-neutral-400 active:bg-white/10"
          >
            高级：编辑 JSON
          </button>
        </div>
      </div>

      {showVersions && (
        <VersionSheet
          id={id}
          dirty={dirty}
          onClose={() => setShowVersions(false)}
          onRestored={(drill) => {
            // 恢复已经写进服务端了，所以连基线一起换：恢复完就是「已保存」状态
            onSaved(drill)
            dispatch({ type: 'replaceDrill', drill })
            setSelectedKey(undefined)
            setShowVersions(false)
          }}
        />
      )}

      {showJson && (
        <JsonSheet
          drill={state.drill}
          onClose={() => setShowJson(false)}
          onApply={(drill) => {
            dispatch({ type: 'replaceDrill', drill })
            setSelectedKey(undefined)
            setShowJson(false)
          }}
        />
      )}
    </div>
  )
}

/** 高级入口：直接看/改 JSON，应用前过同一套校验。 */
function JsonSheet({
  drill,
  onClose,
  onApply,
}: {
  drill: Drill
  onClose: () => void
  onApply: (drill: Drill) => void
}) {
  const [text, setText] = useState(() => JSON.stringify(drill, null, 2))
  const [error, setError] = useState<string>()

  const apply = () => {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (parseError) {
      setError(`JSON 语法错误：${parseError instanceof Error ? parseError.message : ''}`)
      return
    }
    const result = parseDrill(raw)
    if (!result.ok) {
      setError(formatIssues(result.issues))
      return
    }
    onApply(result.drill)
  }

  return (
    <div className="fixed inset-0 z-10 flex flex-col bg-neutral-950">
      <header className="flex shrink-0 items-center gap-2 px-3 pt-[max(10px,env(safe-area-inset-top))]">
        <h2 className="flex-1 text-sm font-semibold">直接编辑 JSON</h2>
        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl bg-white/10 px-3 text-sm font-semibold"
        >
          取消
        </button>
        <button
          type="button"
          onClick={apply}
          className="h-11 rounded-xl bg-emerald-500 px-3 text-sm font-semibold text-neutral-950"
        >
          应用
        </button>
      </header>
      {error !== undefined && (
        <pre className="mx-3 mt-2 max-h-32 shrink-0 overflow-y-auto whitespace-pre-wrap rounded-xl bg-red-500/15 p-3 text-[11px] text-red-200">
          {error}
        </pre>
      )}
      <textarea
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        spellCheck={false}
        className="m-3 min-h-0 flex-1 rounded-xl bg-white/5 p-3 font-mono text-[11px] leading-relaxed outline-none"
      />
    </div>
  )
}

function Chip({
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

function IconButton({
  disabled,
  onClick,
  label,
  children,
}: {
  disabled: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="h-11 w-11 shrink-0 rounded-xl bg-white/10 text-base disabled:text-neutral-600 active:bg-white/20"
    >
      {children}
    </button>
  )
}
