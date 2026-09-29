import { useEffect, useRef, useState, type RefObject } from 'react'

export interface CanvasSize {
  width: number
  height: number
}

/**
 * 管理一块自适应容器、按 devicePixelRatio 放大的画布。
 *
 * 播放器和编辑器共用这一份：DPR 换算和「元素被 React 卸载重建后要重新初始化」
 * 这两件事之前出过 bug（新建的 canvas 停在默认 300×150 被拉伸成模糊一团），
 * 不能有两份实现。
 *
 * container 和 canvas 用回调 ref 存进 state，这样节点变化时 effect 会重跑。
 */
export function useCanvasSurface(): {
  setContainer: (element: HTMLDivElement | null) => void
  setCanvas: (element: HTMLCanvasElement | null) => void
  canvas: HTMLCanvasElement | null
  /** 逻辑尺寸，供 requestAnimationFrame 循环读，不触发重渲染。 */
  sizeRef: RefObject<CanvasSize>
  /** 同一个尺寸的 state 版本，供 React 定位 DOM 手柄。 */
  size: CanvasSize
} {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const sizeRef = useRef<CanvasSize>({ width: 0, height: 0 })
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 })

  useEffect(() => {
    if (container === null || canvas === null) return

    const resize = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      if (width === 0 || height === 0) return

      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      sizeRef.current = { width, height }
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      )

      const ctx = canvas.getContext('2d')
      // 之后都用逻辑像素作图，dpr 的事在这里一次性处理掉
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    window.addEventListener('orientationchange', resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('orientationchange', resize)
    }
  }, [container, canvas])

  return { setContainer, setCanvas, canvas, sizeRef, size }
}
