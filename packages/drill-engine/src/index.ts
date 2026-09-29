export {
  BALL_DISTANCE,
  DEFAULT_FACING,
  ballOffsetFrom,
  compileDrill,
  compileVariant,
  footOf,
  resolveRef,
} from './compile.js'
export type {
  ActorMotion,
  BallMotion,
  CompiledTurn,
  RoundInfo,
  Segment,
  Timeline,
} from './compile.js'

export { sampleTimeline } from './sample.js'
export type {
  ActorFrame,
  BallFrame,
  FrameState,
  TrailFrame,
  TurnHighlightFrame,
} from './sample.js'

export { solveTurn } from './turn.js'
export type { TurnDirection, TurnSolution } from './turn.js'

export {
  add,
  clamp01,
  distance,
  easeInOut,
  facingVector,
  headingOf,
  length,
  lerp,
  lerpVec,
  normalize,
  normalizeDeg,
  polylineHeading,
  polylineLength,
  polylinePoint,
  polylineUpTo,
  scale,
  sub,
} from './math.js'
