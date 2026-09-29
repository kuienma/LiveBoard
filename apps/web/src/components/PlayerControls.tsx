import type { RefObject } from 'react'
import { SPEEDS, type Speed } from '../useDrillPlayer.js'

/**
 * stacked：进度条一行、按钮一行（竖屏，以及矮而窄的窗口）。
 * column：手机横屏的侧栏，竖着排。
 */
export type ControlsLayout = 'stacked' | 'column'

interface Props {
  duration: number
  playing: boolean
  speed: Speed
  layout: ControlsLayout
  sliderRef: RefObject<HTMLInputElement | null>
  clockRef: RefObject<HTMLSpanElement | null>
  fpsRef: RefObject<HTMLSpanElement | null>
  onTogglePlay: () => void
  onRestart: () => void
  onSpeedChange: (speed: Speed) => void
  onSeekStart: () => void
  onSeekEnd: () => void
  onSeek: (seconds: number) => void
}

/** 播放控件。可点区域不低于 40px，竖屏与横屏都保持 44px。 */
export function PlayerControls({
  duration,
  playing,
  speed,
  layout,
  sliderRef,
  clockRef,
  fpsRef,
  onTogglePlay,
  onRestart,
  onSpeedChange,
  onSeekStart,
  onSeekEnd,
  onSeek,
}: Props) {
  const column = layout === 'column'

  const slider = (
    <input
      ref={sliderRef}
      type="range"
      min={0}
      max={duration}
      step={0.02}
      defaultValue={0}
      aria-label="播放进度"
      className={column ? 'h-9 w-full' : 'h-11 min-w-0 flex-1'}
      onPointerDown={onSeekStart}
      onPointerUp={onSeekEnd}
      onPointerCancel={onSeekEnd}
      onInput={(event) => onSeek(Number(event.currentTarget.value))}
    />
  )

  const clock = (
    <span
      ref={clockRef}
      className="shrink-0 text-right font-mono text-xs tabular-nums text-neutral-400"
    >
      0.0 / {duration.toFixed(1)}s
    </span>
  )

  // 真机上用来核对「至少 30fps」这条验收项
  const fps = (
    <span ref={fpsRef} className="shrink-0 font-mono text-[11px] text-neutral-500">
      — fps
    </span>
  )

  const transport = (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={onTogglePlay}
        className={[
          'h-11 rounded-xl bg-emerald-500 text-sm font-semibold text-neutral-950 active:bg-emerald-400',
          column ? 'flex-1' : 'min-w-[76px] px-4',
        ].join(' ')}
      >
        {playing ? '暂停' : '播放'}
      </button>
      <button
        type="button"
        onClick={onRestart}
        className={[
          'h-11 rounded-xl bg-white/10 text-sm font-semibold text-neutral-100 active:bg-white/20',
          column ? 'flex-1' : 'min-w-[64px] px-4',
        ].join(' ')}
      >
        重播
      </button>
    </div>
  )

  const speeds = (
    <div
      className={[
        'flex overflow-hidden rounded-xl bg-white/10',
        column ? 'w-full' : 'ml-auto',
      ].join(' ')}
    >
      {SPEEDS.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onSpeedChange(option)}
          aria-pressed={option === speed}
          className={[
            'h-11 text-sm font-semibold transition-colors',
            column ? 'flex-1' : 'w-14',
            option === speed
              ? 'bg-emerald-500 text-neutral-950'
              : 'text-neutral-300 active:bg-white/20',
          ].join(' ')}
        >
          {option}x
        </button>
      ))}
    </div>
  )

  if (column) {
    return (
      <div className="flex flex-col gap-2">
        {slider}
        <div className="flex items-center justify-between gap-2">
          {clock}
          {fps}
        </div>
        {transport}
        {speeds}
      </div>
    )
  }

  return (
    <div className="shrink-0 space-y-2 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2">
      <div className="flex items-center gap-3">
        {slider}
        {clock}
      </div>
      <div className="flex items-center gap-2">
        {transport}
        {speeds}
      </div>
      <div className="flex justify-end">{fps}</div>
    </div>
  )
}
