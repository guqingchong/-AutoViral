export interface ImageOpts {
  prompt: string
  width?: number
  height?: number
  referenceImage?: string
  workId: string
  filename: string
  // OpenRouter image_config
  aspectRatio?: string
  imageSize?: string
  seed?: number
  temperature?: number
  model?: string
}

export interface VideoOpts {
  prompt: string
  firstFrame?: string
  lastFrame?: string
  resolution?: string
  duration?: number       // 4-15 seconds (Dreamina CLI)
  modelVersion?: string   // e.g. 'seedance2.0', 'seedance2.0fast'
  // Seedance / 多参考视觉模型
  referenceImages?: string[]                            // 公网可访问的图片 URL 列表
  referenceVideos?: string[]                            // 公网可访问的视频 URL 列表(传入则触发 Seedance 有参考模式)
  ratio?: '16:9' | '9:16' | '4:3' | '3:4'              // 画幅比例
  durationHint?: '~15s' | '~30s' | '40~60s'            // Seedance 时长档位(Agent 自定时长,带~符号表示模糊匹配)
  language?: 'Chinese' | 'English' | 'Japanese' | 'Korean' | string
  workId: string
  filename: string
}

export interface AudioOpts {
  text: string
  voice?: string
  speed?: number
  workId: string
  filename: string
}

export interface MusicOpts {
  prompt: string                  // 风格描述：如 "lo-fi 雨夜，钢琴铺底，慢速 70bpm"
  lyrics?: string                  // 留空 → 纯 BGM；填入 → 带歌词的歌曲
  duration?: number                // 期望时长（秒），默认 30
  workId: string
  filename: string
}

export interface GenerateResult {
  success: boolean
  assetPath?: string
  previewUrl?: string
  error?: string
  code?: 'TIMEOUT' | 'API_ERROR' | 'DOWNLOAD_FAILED' | 'INVALID_PARAMS' | 'ACCESS_DENIED'
}

export interface GenerateProvider {
  name: string
  supportsImage: boolean
  supportsVideo: boolean
  supportsAudio?: boolean
  supportsMusic?: boolean
  generateImage(opts: ImageOpts): Promise<GenerateResult>
  generateVideo(opts: VideoOpts): Promise<GenerateResult>
  generateAudio?(opts: AudioOpts): Promise<GenerateResult>
  generateMusic?(opts: MusicOpts): Promise<GenerateResult>
}
