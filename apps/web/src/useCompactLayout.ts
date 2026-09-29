import { useEffect, useState } from 'react'

/** 矮屏：可用高度不足，标题/说明/控件都要让位给场地。手机横屏一定命中。 */
const DENSE = '(max-height: 560px)'

/**
 * 矮且宽：控件改成侧边竖排，画布拿到完整高度。
 * 要求宽度足够（≥600px），否则切掉 160px 侧栏反而让场地更小——
 * 窄的矮窗口用横向压扁排布更划算。
 */
const SIDE_COLUMN = '(max-height: 560px) and (min-width: 600px)'

export interface CompactLayout {
  /** 压扁周边：标题与标签同行、隐藏练法说明。 */
  dense: boolean
  /** 控件竖排在左侧，场地占满高度。 */
  sideColumn: boolean
}

const read = (): CompactLayout => {
  if (typeof window === 'undefined') return { dense: false, sideColumn: false }
  return {
    dense: window.matchMedia(DENSE).matches,
    sideColumn: window.matchMedia(SIDE_COLUMN).matches,
  }
}

/**
 * 手机横屏时可用高度只有 ~390px，按竖屏那样把标题、标签、说明、控件层层堆叠，
 * 场地只剩两百来像素。这个 hook 回答该用哪种排布，具体怎么排交给各组件。
 */
export function useCompactLayout(): CompactLayout {
  const [layout, setLayout] = useState(read)

  useEffect(() => {
    const queries = [window.matchMedia(DENSE), window.matchMedia(SIDE_COLUMN)]
    const onChange = () => setLayout(read())
    onChange()
    for (const query of queries) query.addEventListener('change', onChange)
    return () => {
      for (const query of queries) query.removeEventListener('change', onChange)
    }
  }, [])

  return layout
}
