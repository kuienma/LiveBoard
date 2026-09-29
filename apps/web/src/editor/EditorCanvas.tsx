import type { FrameState } from '@drill/engine'
import { computeLayout, drawFrame, type Layout } from '@drill/render'
import type { Vec2 } from '@drill/schema'
import { useEffect, useRef, useState } from 'react'
import { useCanvasSurface } from '../useCanvasSurface.js'
import type { Handle } from './handles.js'

/** 触控区域直径，满足「至少 44px」。 */
const HANDLE_SIZE = 44

interface Props {
  /** 当前关键帧对应的静态帧，由 EditorPage 算好传进来。 */
  frame: FrameState
  /** 可拖的手柄，同样由 EditorPage 统一构建，保证面板和画布看到的是同一份。 */
  handles: Handle[]
  selectedKey?: string
  onSelect: (handle: Handle) => void
  onDrag: (handle: Handle, pos: Vec2) => void
  onDragEnd: () => void
}

export function EditorCanvas({
  frame,
  handles,
  selectedKey,
  onSelect,
  onDrag,
  onDragEnd,
}: Props) {
  const surface = useCanvasSurface()
  const [layout, setLayout] = useState<Layout>()
  /** 拖动时手指与对象中心的偏移，避免对象瞬移到手指下。 */
  const grabOffset = useRef<Vec2>([0, 0])
  const canvasRect = useRef<DOMRect | undefined>(undefined)

  // 画面变了就重绘一次。编辑态是静态帧，不需要 rAF 循环。
  useEffect(() => {
    const { canvas } = surface
    const { width, height } = surface.size
    if (canvas === null || width === 0 || height === 0) return

    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    // 编辑时关掉说明条和跑动虚线：要看清的是静态布局，不是动画
    drawFrame(ctx, frame, { width, height }, { showNarration: false, showTrails: false })
    setLayout(computeLayout(frame, { width, height }, { showNarration: false }))
  }, [surface, frame])

  const startDrag = (handle: Handle) => (event: React.PointerEvent<HTMLButtonElement>) => {
    onSelect(handle)
    if (handle.target === undefined || layout === undefined || surface.canvas === null) return

    event.currentTarget.setPointerCapture(event.pointerId)
    canvasRect.current = surface.canvas.getBoundingClientRect()

    const [px, py] = layout.toPx(handle.pos)
    grabOffset.current = [
      event.clientX - (canvasRect.current.left + px),
      event.clientY - (canvasRect.current.top + py),
    ]
  }

  const moveDrag = (handle: Handle) => (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = canvasRect.current
    if (
      handle.target === undefined ||
      layout === undefined ||
      rect === undefined ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return
    }

    const [dx, dy] = grabOffset.current
    onDrag(
      handle,
      layout.toField([event.clientX - rect.left - dx, event.clientY - rect.top - dy]),
    )
  }

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    canvasRect.current = undefined
    onDragEnd()
  }

  return (
    <div ref={surface.setContainer} className="relative h-full w-full">
      <canvas ref={surface.setCanvas} className="block touch-none" />

      {layout !== undefined &&
        handles.map((handle) => {
          const [px, py] = layout.toPx(handle.pos)
          const draggable = handle.target !== undefined
          const selected = handle.key === selectedKey

          return (
            <button
              key={handle.key}
              type="button"
              aria-label={`${handle.kind === 'object' ? '器材' : '球员'} ${handle.label}`}
              onPointerDown={startDrag(handle)}
              onPointerMove={moveDrag(handle)}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{
                left: px - HANDLE_SIZE / 2,
                top: py - HANDLE_SIZE / 2,
                width: HANDLE_SIZE,
                height: HANDLE_SIZE,
              }}
              className={[
                'absolute touch-none rounded-full transition-colors',
                // 手柄本身透明，只在选中或不可拖时给出可见反馈，
                // 否则会挡住下面画好的球员和锥桶
                selected
                  ? 'bg-emerald-400/25 ring-2 ring-emerald-300'
                  : draggable
                    ? 'active:bg-white/10'
                    : 'ring-1 ring-white/15',
              ].join(' ')}
            />
          )
        })}
    </div>
  )
}
