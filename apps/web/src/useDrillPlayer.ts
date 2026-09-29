import { sampleTimeline, type Timeline } from '@drill/engine'
import { drawFrame } from '@drill/render'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCanvasSurface } from './useCanvasSurface.js'

export const SPEEDS = [0.5, 1, 1.5] as const
export type Speed = (typeof SPEEDS)[number]

/**
 * 播放器状态机。
 *
 * 关键取舍一：时间放在 ref 里而不是 state 里，每帧在 requestAnimationFrame 里直接
 * 重绘 canvas 并用 DOM 引用更新进度条和时间，完全不触发 React 重渲染——
 * 中档安卓上 60fps 也不会因为每帧 re-render 掉帧。
 * React state 只保留播放/速度这些低频状态。
 *
 * 画布尺寸与 DPR 的处理交给 useCanvasSurface，编辑器共用同一份——
 * 「元素被 React 卸载重建后要重新初始化」这件事之前出过 bug，不该有两份实现。
 */
export function useDrillPlayer(timeline: Timeline) {
  const { setContainer, setCanvas, canvas, sizeRef } = useCanvasSurface()

  const sliderRef = useRef<HTMLInputElement | null>(null)
  const clockRef = useRef<HTMLSpanElement | null>(null)
  const fpsRef = useRef<HTMLSpanElement | null>(null)

  const timeRef = useRef(0)
  const playingRef = useRef(true)
  const speedRef = useRef<number>(1)
  const seekingRef = useRef(false)

  const [playing, setPlaying] = useState(true)
  const [speed, setSpeedState] = useState<Speed>(1)

  // 切换练法时从头开始
  useEffect(() => {
    timeRef.current = 0
  }, [timeline])

  // 主循环
  useEffect(() => {
    if (canvas === null) return

    let raf = 0
    let last = performance.now()
    let fpsFrames = 0
    let fpsSince = last

    const tick = (now: number) => {
      // 切后台再回来时 now - last 会很大，夹一下避免时间瞬间跳一大段
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now

      if (playingRef.current && !seekingRef.current) {
        timeRef.current += dt * speedRef.current
        if (timeRef.current >= timeline.duration) {
          timeRef.current = 0 // 循环播放，方便反复看
        }
      }

      const ctx = canvas.getContext('2d')
      const { width, height } = sizeRef.current
      if (ctx !== null && width > 0 && height > 0) {
        const frame = sampleTimeline(timeline, timeRef.current)
        drawFrame(ctx, frame, { width, height })
      }

      if (!seekingRef.current && sliderRef.current !== null) {
        sliderRef.current.value = String(timeRef.current)
      }
      if (clockRef.current !== null) {
        clockRef.current.textContent = `${timeRef.current.toFixed(1)} / ${timeline.duration.toFixed(1)}s`
      }

      fpsFrames++
      if (now - fpsSince >= 500) {
        if (fpsRef.current !== null) {
          fpsRef.current.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsSince))} fps`
        }
        fpsFrames = 0
        fpsSince = now
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [canvas, timeline])

  const togglePlay = useCallback(() => {
    playingRef.current = !playingRef.current
    setPlaying(playingRef.current)
  }, [])

  const restart = useCallback(() => {
    timeRef.current = 0
    playingRef.current = true
    setPlaying(true)
  }, [])

  const changeSpeed = useCallback((next: Speed) => {
    speedRef.current = next
    setSpeedState(next)
  }, [])

  const beginSeek = useCallback(() => {
    seekingRef.current = true
  }, [])

  const endSeek = useCallback(() => {
    seekingRef.current = false
  }, [])

  const seekTo = useCallback((seconds: number) => {
    timeRef.current = Math.max(seconds, 0)
  }, [])

  return {
    setContainer,
    setCanvas,
    sliderRef,
    clockRef,
    fpsRef,
    playing,
    speed,
    togglePlay,
    restart,
    changeSpeed,
    beginSeek,
    endSeek,
    seekTo,
  }
}
