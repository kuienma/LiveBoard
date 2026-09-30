import type { Color } from '@drill/schema'

/**
 * 配色与尺寸常量。文档没规定具体样式，按「简洁、移动优先」定：
 * 草地绿底 + 浅色割草条纹，白色边线，进攻红、防守白、教练蓝。
 */
export const theme = {
  /** 画布留白区（场地之外）的底色。 */
  canvasBackground: '#101613',
  pitch: '#3f7d49',
  pitchStripe: '#478a52',
  boardBackground: '#13463a',
  line: 'rgba(255, 255, 255, 0.72)',

  narrationBackground: 'rgba(8, 12, 10, 0.78)',
  narrationText: '#f4f7f2',
  badgeBackground: 'rgba(240, 196, 25, 0.92)',
  badgeText: '#1d1600',

  ball: '#fdfdfb',
  ballOutline: '#23291f',

  trail: {
    attacker: 'rgba(255, 233, 120, 0.9)',
    defender: 'rgba(238, 244, 255, 0.72)',
    neutral: 'rgba(255, 255, 255, 0.6)',
    coach: 'rgba(255, 255, 255, 0.45)',
  },

  turnHighlight: '#ffd233',

  /** 球员圆点的填充与文字色。 */
  actor: {
    attacker: { fill: '#d92b2b', text: '#ffffff', ring: 'rgba(0,0,0,0.35)' },
    defender: { fill: '#f2f4f0', text: '#22251f', ring: 'rgba(0,0,0,0.35)' },
    neutral: { fill: '#f0c419', text: '#22251f', ring: 'rgba(0,0,0,0.35)' },
    coach: { fill: '#2a6fb0', text: '#ffffff', ring: 'rgba(0,0,0,0.35)' },
  },

  /** 米制尺寸。 */
  size: {
    actorRadius: 0.5,
    ballRadius: 0.15,
    coneTall: 0.6,
    coneShort: 0.35,
    trailWidth: 0.09,
    lineWidth: 0.08,
    /** 带球波浪线：一个波长 1.1 米、单侧振幅 0.26 米（20 米宽的场地上清晰可辨）。 */
    dribbleWavelength: 1.1,
    dribbleAmplitude: 0.26,
  },
} as const

export const objectColors: Record<Color, string> = {
  red: '#d93b2b',
  orange: '#f07c1e',
  yellow: '#f0c419',
  green: '#3fae5a',
  blue: '#2a6fb0',
  white: '#f2f4f0',
  black: '#25282a',
}

export const CJK_FONT_STACK =
  'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
