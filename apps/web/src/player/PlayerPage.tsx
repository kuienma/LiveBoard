import { compileDrill } from '@drill/engine'
import { useEffect, useMemo, useState } from 'react'
import { PlayerControls } from '../components/PlayerControls.js'
import { VariantTabs } from '../components/VariantTabs.js'
import { ApiError, CATEGORY_LABEL, getDrill, type DrillDetail } from '../library/api.js'
import { useCompactLayout } from '../useCompactLayout.js'
import { useDrillPlayer } from '../useDrillPlayer.js'
import { ExportSheet } from './ExportSheet.js'

interface Props {
  id: string
  onBack: () => void
  onEdit: () => void
}

export function PlayerPage({ id, onBack, onEdit }: Props) {
  const [detail, setDetail] = useState<DrillDetail>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setDetail(undefined)
    setError(undefined)
    getDrill(id)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (error !== undefined) {
    return (
      <div className="flex h-full flex-col gap-4 p-4">
        <button
          type="button"
          onClick={onBack}
          className="h-11 self-start rounded-xl bg-white/10 px-3 text-sm font-semibold active:bg-white/20"
        >
          返回训练库
        </button>
        <p className="whitespace-pre-wrap rounded-xl bg-red-500/15 p-3 text-xs leading-relaxed text-red-300">
          {error}
        </p>
      </div>
    )
  }

  if (detail === undefined) {
    return <p className="flex h-full items-center justify-center text-sm text-neutral-500">加载中…</p>
  }

  return <Board key={detail.id} detail={detail} onBack={onBack} onEdit={onEdit} />
}

function Board({
  detail,
  onBack,
  onEdit,
}: {
  detail: DrillDetail
  onBack: () => void
  onEdit: () => void
}) {
  const timelines = useMemo(() => compileDrill(detail.drill), [detail.drill])
  const [variantId, setVariantId] = useState(timelines[0]?.variantId ?? '')
  const timeline = timelines.find((t) => t.variantId === variantId) ?? timelines[0]!
  const { dense, sideColumn } = useCompactLayout()
  const player = useDrillPlayer(timeline)
  const [showExport, setShowExport] = useState(false)

  const backButton = (
    <button
      type="button"
      onClick={onBack}
      aria-label="返回训练库"
      className="h-11 w-11 shrink-0 rounded-xl bg-white/10 text-base active:bg-white/20"
    >
      ‹
    </button>
  )

  const editButton = (
    <button
      type="button"
      onClick={onEdit}
      className="h-11 shrink-0 rounded-xl bg-white/10 px-3 text-sm font-semibold active:bg-white/20"
    >
      编辑
    </button>
  )

  const exportButton = (
    <button
      type="button"
      onClick={() => setShowExport(true)}
      className="h-11 shrink-0 rounded-xl bg-white/10 px-3 text-sm font-semibold active:bg-white/20"
    >
      导出
    </button>
  )

  const controls = (layout: 'stacked' | 'column') => (
    <PlayerControls
      duration={timeline.duration}
      playing={player.playing}
      speed={player.speed}
      layout={layout}
      sliderRef={player.sliderRef}
      clockRef={player.clockRef}
      fpsRef={player.fpsRef}
      onTogglePlay={player.togglePlay}
      onRestart={player.restart}
      onSpeedChange={player.changeSpeed}
      onSeekStart={player.beginSeek}
      onSeekEnd={player.endSeek}
      onSeek={player.seekTo}
    />
  )

  const pitch = (
    <div
      ref={player.setContainer}
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
    >
      {/* shrink-0：画布的宽高是按容器算好的，不能再被 flex 压缩，否则会被拉伸发虚 */}
      <canvas ref={player.setCanvas} className="block shrink-0 touch-none" />
    </div>
  )

  // fixed 定位，挂在哪个分支下都一样，定义一次两处复用
  const exportSheet = showExport ? (
    <ExportSheet
      drillId={detail.id}
      drill={detail.drill}
      currentVariantId={timeline.variantId}
      onClose={() => setShowExport(false)}
    />
  ) : null

  // 手机横屏：控件竖排在左侧，场地拿到完整高度
  if (sideColumn) {
    return (
      <div className="flex h-full">
        <aside className="flex w-[164px] shrink-0 flex-col gap-2 py-2 pl-[max(8px,env(safe-area-inset-left))] pr-1">
          <div className="flex items-center gap-2">
            {backButton}
            <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{detail.title}</h1>
          </div>
          <VariantTabs
            timelines={timelines}
            activeId={timeline.variantId}
            onSelect={setVariantId}
            orientation="vertical"
          />
          <div className="mt-auto space-y-2">
            <div className="flex gap-2">
              {editButton}
              {exportButton}
            </div>
            {controls('column')}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 pr-[max(4px,env(safe-area-inset-right))]">{pitch}</div>
        {exportSheet}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className={
          dense
            ? 'flex shrink-0 items-center gap-2 px-3 pt-[max(6px,env(safe-area-inset-top))]'
            : 'flex shrink-0 items-start gap-2 px-3 pt-[max(10px,env(safe-area-inset-top))]'
        }
      >
        {backButton}
        <header className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold leading-tight">{detail.title}</h1>
          {!dense && (
            <p className="mt-0.5 truncate text-xs text-neutral-400">
              {/* 出处里通常已经含章节名（含类别），有出处就只显示出处，避免「运球 · 第3章 运球」 */}
              {detail.source ?? CATEGORY_LABEL[detail.category] ?? detail.category}
            </p>
          )}
        </header>
        {dense && (
          <div className="min-w-0 flex-[2]">
            <VariantTabs
              timelines={timelines}
              activeId={timeline.variantId}
              onSelect={setVariantId}
              dense
            />
          </div>
        )}
        {editButton}
        {exportButton}
      </div>

      {!dense && (
        <>
          <VariantTabs
            timelines={timelines}
            activeId={timeline.variantId}
            onSelect={setVariantId}
          />
          {timeline.description !== undefined && (
            <p className="shrink-0 px-3 pb-2 text-xs leading-relaxed text-neutral-400">
              {timeline.description}
            </p>
          )}
        </>
      )}

      <div className="flex min-h-0 flex-1 px-1">{pitch}</div>

      {controls('stacked')}
      {exportSheet}
    </div>
  )
}
