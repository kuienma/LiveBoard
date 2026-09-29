import { isTowardPos, type Drill } from '@drill/schema'
import { ACTION_TYPE_LABEL, type EditorAction } from './editorState.js'
import { HANDLE_BLOCK_LABEL, type Handle, type Keyframe } from './handles.js'
import { NOT_DRAGGABLE_LABEL } from './positionRef.js'

const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'white', 'black'] as const
const COLOR_LABEL: Record<string, string> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  white: '白',
  black: '黑',
}
const ACTION_TYPES = ['run', 'dribble', 'turn', 'pass', 'shoot', 'wait'] as const

interface Props {
  drill: Drill
  variantId: string
  keyframe: Keyframe
  selected?: Handle
  dispatch: (action: EditorAction) => void
  /** 插入阶段后跳到新阶段——插完总是要接着编辑它。 */
  onSelectPhase: (index: number) => void
}

/** 属性面板：选中对象时改它的属性，否则改当前练法/阶段。 */
export function InspectorPanel({
  drill,
  variantId,
  keyframe,
  selected,
  dispatch,
  onSelectPhase,
}: Props) {
  const variant = drill.variants.find((item) => item.id === variantId)
  if (variant === undefined) return null

  return (
    <div className="space-y-4">
      {selected !== undefined && (
        <Section title={`选中：${selected.label}`}>
          {selected.reason !== undefined && (
            <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
              {selected.reason in HANDLE_BLOCK_LABEL
                ? HANDLE_BLOCK_LABEL[selected.reason as keyof typeof HANDLE_BLOCK_LABEL]
                : NOT_DRAGGABLE_LABEL[selected.reason as keyof typeof NOT_DRAGGABLE_LABEL]}
            </p>
          )}
          <p className="text-[11px] text-neutral-500">
            位置 [{selected.pos[0].toFixed(1)}, {selected.pos[1].toFixed(1)}]
          </p>
          {selected.kind === 'object' ? (
            <ObjectFields
              drill={drill}
              id={selected.key.slice('object:'.length)}
              dispatch={dispatch}
            />
          ) : (
            <ActorFields
              drill={drill}
              id={selected.key.slice('actor:'.length)}
              dispatch={dispatch}
            />
          )}
        </Section>
      )}

      {keyframe.kind === 'phase' && (
        <PhaseFields
          drill={drill}
          variantId={variantId}
          phaseIndex={keyframe.index}
          dispatch={dispatch}
        />
      )}

      <Section title="练法">
        <Field label="名称">
          <input
            value={variant.name}
            onChange={(event) =>
              dispatch({
                type: 'patchVariant',
                variantId,
                patch: { name: event.currentTarget.value },
              })
            }
            className={inputClass}
          />
        </Field>
        <Field label="说明">
          <textarea
            value={variant.description ?? ''}
            rows={2}
            onChange={(event) =>
              dispatch({
                type: 'patchVariant',
                variantId,
                patch: { description: event.currentTarget.value },
              })
            }
            className={`${inputClass} h-auto py-2`}
          />
        </Field>
        <Field label="轮数">
          <input
            type="number"
            min={1}
            value={variant.repeat?.times ?? 1}
            onChange={(event) =>
              dispatch({
                type: 'setRepeatTimes',
                variantId,
                times: Number(event.currentTarget.value),
              })
            }
            className={inputClass}
          />
        </Field>
      </Section>

      <Section title="标题">
        <input
          value={drill.meta.title}
          onChange={(event) =>
            dispatch({
              type: 'patchMeta',
              patch: { title: event.currentTarget.value },
            })
          }
          className={inputClass}
        />
      </Section>

      <Section title="增删">
        <div className="grid grid-cols-2 gap-2">
          <PanelButton onClick={() => dispatch({ type: 'addObject' })}>加锥桶</PanelButton>
          <PanelButton onClick={() => dispatch({ type: 'addActor', role: 'attacker' })}>
            加进攻球员
          </PanelButton>
          <PanelButton onClick={() => dispatch({ type: 'addActor', role: 'defender' })}>
            加防守球员
          </PanelButton>
          <PanelButton
            onClick={() => {
              const afterIndex = keyframe.kind === 'phase' ? keyframe.index : -1
              dispatch({ type: 'addPhase', variantId, afterIndex })
              onSelectPhase(afterIndex + 1)
            }}
          >
            插入阶段
          </PanelButton>
        </div>
        {selected !== undefined && (
          <PanelButton
            danger
            onClick={() =>
              selected.kind === 'object'
                ? dispatch({
                    type: 'removeObject',
                    id: selected.key.slice('object:'.length),
                  })
                : dispatch({
                    type: 'removeActor',
                    id: selected.key.slice('actor:'.length),
                  })
            }
          >
            删除选中的「{selected.label}」
          </PanelButton>
        )}
      </Section>
    </div>
  )
}

function ObjectFields({
  drill,
  id,
  dispatch,
}: {
  drill: Drill
  id: string
  dispatch: (action: EditorAction) => void
}) {
  const object = drill.objects.find((item) => item.id === id)
  if (object === undefined) return null

  return (
    <>
      <Field label="颜色">
        <div className="flex flex-wrap gap-1.5">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => dispatch({ type: 'patchObject', id, patch: { color } })}
              className={[
                'h-9 min-w-11 rounded-lg px-2 text-xs font-semibold',
                object.color === color
                  ? 'bg-emerald-500 text-neutral-950'
                  : 'bg-white/10 text-neutral-300',
              ].join(' ')}
            >
              {COLOR_LABEL[color]}
            </button>
          ))}
        </div>
      </Field>
      <Field label="高矮">
        <div className="flex gap-2">
          {(['short', 'tall'] as const).map((size) => (
            <button
              key={size}
              type="button"
              onClick={() => dispatch({ type: 'patchObject', id, patch: { size } })}
              className={[
                'h-11 flex-1 rounded-xl text-xs font-semibold',
                object.size === size
                  ? 'bg-emerald-500 text-neutral-950'
                  : 'bg-white/10 text-neutral-300',
              ].join(' ')}
            >
              {size === 'short' ? '矮桶' : '高桶'}
            </button>
          ))}
        </div>
      </Field>
    </>
  )
}

function ActorFields({
  drill,
  id,
  dispatch,
}: {
  drill: Drill
  id: string
  dispatch: (action: EditorAction) => void
}) {
  const actor = drill.actors.find((item) => item.id === id)
  if (actor === undefined) return null

  return (
    <Field label="标签（画在圆点上，最多 3 字）">
      <input
        value={actor.label ?? ''}
        maxLength={3}
        onChange={(event) =>
          dispatch({
            type: 'patchActor',
            id,
            patch: { label: event.currentTarget.value },
          })
        }
        className={inputClass}
      />
    </Field>
  )
}

function PhaseFields({
  drill,
  variantId,
  phaseIndex,
  dispatch,
}: {
  drill: Drill
  variantId: string
  phaseIndex: number
  dispatch: (action: EditorAction) => void
}) {
  const variant = drill.variants.find((item) => item.id === variantId)
  const phase = variant?.phases[phaseIndex]
  if (variant === undefined || phase === undefined) return null

  const actorsWithoutAction = drill.actors.filter(
    (actor) => !phase.actions.some((action) => action.actor === actor.id),
  )

  return (
    <Section title={`阶段 ${phaseIndex + 1}`}>
      <Field label="时长（秒）">
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={phase.duration}
          onChange={(event) =>
            dispatch({
              type: 'patchPhase',
              variantId,
              phaseIndex,
              patch: { duration: Number(event.currentTarget.value) },
            })
          }
          className={inputClass}
        />
      </Field>

      <label className="flex h-11 items-center gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          checked={phase.slowMotion}
          onChange={(event) =>
            dispatch({
              type: 'patchPhase',
              variantId,
              phaseIndex,
              patch: { slowMotion: event.currentTarget.checked },
            })
          }
          className="h-5 w-5"
        />
        慢放（渲染时高亮转身方向，不改变时长）
      </label>

      <div className="space-y-1.5">
        <p className="text-[11px] text-neutral-500">本阶段的动作（同时发生）</p>
        {phase.actions.length === 0 && (
          <p className="text-[11px] text-neutral-500">还没有动作，所有人原地不动。</p>
        )}
        {phase.actions.map((action, actionIndex) => {
          // 提前收窄：narrowing 进不了下面 onChange 的闭包
          const towardTo =
            (action.type === 'run' || action.type === 'dribble' || action.type === 'shoot') &&
            isTowardPos(action.to)
              ? action.to
              : undefined

          return (
            <div
              key={`${action.actor}-${actionIndex}`}
              className="flex items-center gap-2 rounded-xl bg-white/5 px-2 py-1.5"
            >
              <span className="w-10 shrink-0 text-xs font-semibold">{action.actor}</span>
              <select
                value={action.type}
                onChange={(event) => {
                  // 换类型要重建动作，否则字段对不上（比如 turn 没有 to）
                  dispatch({
                    type: 'removeAction',
                    variantId,
                    phaseIndex,
                    actionIndex,
                  })
                  dispatch({
                    type: 'addAction',
                    variantId,
                    phaseIndex,
                    actorId: action.actor,
                    actionType: event.currentTarget.value as (typeof ACTION_TYPES)[number],
                  })
                }}
                className="h-9 min-w-0 flex-1 rounded-lg bg-white/10 px-2 text-xs"
              >
                {ACTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ACTION_TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
              {action.type === 'turn' && (
                <input
                  type="number"
                  step={15}
                  value={action.degrees}
                  aria-label="转身角度"
                  onChange={(event) =>
                    dispatch({
                      type: 'patchAction',
                      variantId,
                      phaseIndex,
                      actionIndex,
                      patch: { degrees: Number(event.currentTarget.value) },
                    })
                  }
                  className="h-9 w-16 rounded-lg bg-white/10 px-2 text-xs"
                />
              )}
              {towardTo !== undefined && (
                // 这种终点是运行时算的，拖不了；停止距离是唯一能调的东西，
                // 手柄上的提示就指向这里，所以必须给出入口
                <input
                  type="number"
                  step={0.5}
                  min={0}
                  value={towardTo.stopShort}
                  aria-label="停止距离（米）"
                  onChange={(event) =>
                    dispatch({
                      type: 'patchAction',
                      variantId,
                      phaseIndex,
                      actionIndex,
                      patch: {
                        to: {
                          toward: towardTo.toward,
                          stopShort: Number(event.currentTarget.value),
                        },
                      },
                    })
                  }
                  className="h-9 w-16 rounded-lg bg-white/10 px-2 text-xs"
                />
              )}
              <button
                type="button"
                onClick={() =>
                  dispatch({
                    type: 'removeAction',
                    variantId,
                    phaseIndex,
                    actionIndex,
                  })
                }
                aria-label={`删除 ${action.actor} 的动作`}
                className="h-9 w-9 shrink-0 rounded-lg text-xs text-red-300 active:bg-white/10"
              >
                ✕
              </button>
            </div>
          )
        })}

        {actorsWithoutAction.length > 0 && (
          <select
            value=""
            onChange={(event) => {
              if (event.currentTarget.value === '') return
              dispatch({
                type: 'addAction',
                variantId,
                phaseIndex,
                actorId: event.currentTarget.value,
                actionType: 'run',
              })
              event.currentTarget.value = ''
            }}
            className="h-11 w-full rounded-xl bg-white/10 px-2 text-xs"
          >
            <option value="">＋ 给某人添加动作…</option>
            {actorsWithoutAction.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.label ?? actor.id}
              </option>
            ))}
          </select>
        )}
      </div>

      {variant.phases.length > 1 && (
        <PanelButton
          danger
          onClick={() => dispatch({ type: 'removePhase', variantId, phaseIndex })}
        >
          删除这个阶段
        </PanelButton>
      )}
    </Section>
  )
}

const inputClass = 'h-11 w-full rounded-xl bg-white/10 px-3 text-sm outline-none focus:bg-white/15'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-neutral-400">{title}</h2>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-neutral-500">{label}</span>
      {children}
    </label>
  )
}

function PanelButton({
  onClick,
  danger = false,
  children,
}: {
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'h-11 w-full rounded-xl text-xs font-semibold active:opacity-80',
        danger ? 'bg-red-500/15 text-red-300' : 'bg-white/10 text-neutral-200',
      ].join(' ')}
    >
      {children}
    </button>
  )
}
