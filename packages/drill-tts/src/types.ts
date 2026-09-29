/** 合成出来的音频。format 用扩展名表示，交给 ffmpeg 时按它命名临时文件。 */
export interface TtsAudio {
  data: Buffer
  format: 'mp3' | 'wav' | 'aiff'
}

export interface TtsRequest {
  text: string
  /** 发音人。取值由各提供商自己定义。 */
  voice?: string
  /** 语速倍率，1 为正常。 */
  speed?: number
}

/**
 * 文字转语音的提供商。
 *
 * 和 VisionProvider 一样做成接口：本地开发用系统自带的合成器（零成本、不出网），
 * 线上用云端合成，换提供商不该动到导出流程。
 */
export interface TtsProvider {
  readonly kind: string
  /** 默认发音人，供界面展示。 */
  readonly defaultVoice: string
  synthesize(request: TtsRequest): Promise<TtsAudio>
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'TtsError'
  }
}
