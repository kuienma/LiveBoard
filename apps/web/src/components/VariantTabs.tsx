import type { Timeline } from '@drill/engine'

interface Props {
  timelines: Timeline[]
  activeId: string
  onSelect: (variantId: string) => void
  /** vertical 用于横屏侧栏。 */
  orientation?: 'horizontal' | 'vertical'
  /** 去掉外边距，交给父容器控制。 */
  dense?: boolean
}

/** 练法切换标签页。触控高度不低于 40px，横向排列时可滚动以适应更多练法。 */
export function VariantTabs({
  timelines,
  activeId,
  onSelect,
  orientation = 'horizontal',
  dense = false,
}: Props) {
  const vertical = orientation === 'vertical'

  return (
    <div
      role="tablist"
      aria-label="练法"
      aria-orientation={orientation}
      className={[
        'flex shrink-0 gap-2',
        vertical ? 'flex-col' : 'overflow-x-auto',
        dense || vertical ? '' : 'px-3 py-2',
      ].join(' ')}
    >
      {timelines.map((timeline) => {
        const active = timeline.variantId === activeId
        return (
          <button
            key={timeline.variantId}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(timeline.variantId)}
            className={[
              'shrink-0 rounded-full text-sm font-semibold transition-colors',
              vertical ? 'h-10 w-full px-3' : 'h-11 px-4',
              active
                ? 'bg-emerald-500 text-neutral-950'
                : 'bg-white/10 text-neutral-200 active:bg-white/20',
            ].join(' ')}
          >
            {timeline.variantName}
          </button>
        )
      })}
    </div>
  )
}
