export interface ImageOpts {
  prompt: string
  width?: number
  height?: number
  referenceImage?: string                   // 单张参考(base64 或 URL),向后兼容老调用
  referenceImages?: string[]                // 多张参考图 URL(0-14 张),即梦 4.6 / 4.6 类多图模型用
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
  // MiniMax 多语种 TTS 模型默认不识别语种,缺省会按音素自由猜,长文本极易猜偏
  // 传入显式语种(如 'Chinese' / 'English' / 'auto')可强制走对应语种音素映射
  languageBoost?: string
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

// 局部重绘 / 消除笔(inpainting)
export interface ImageEditOpts {
  prompt: string                   // <= 120 字符；"删除" 二字触发消除模式；其它字符触发涂抹编辑
  originalImage: string            // 原图 URL(公网可访问) 或 base64
  maskImage: string                // mask 图 URL/base64,单通道灰度,0=保留 / 255=重绘,与原图同尺寸
  seed?: number                    // 默认 101,-1 表示随机
  workId: string
  filename: string
}

// 智能超清(图像 4K/8K 升清)
export interface ImageUpscaleOpts {
  originalImage: string            // 原图 URL 或 base64,JPEG/PNG,<=4.7MB,<=4096*4096
  resolution?: '4k' | '8k'         // 默认 '4k'
  scale?: number                   // 0-100,细节生成程度,默认 50
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
  supportsImageEdit?: boolean             // 局部重绘 / 消除笔(inpainting)
  supportsImageUpscale?: boolean          // 智能超清(4K/8K 升清)
  generateImage(opts: ImageOpts): Promise<GenerateResult>
  generateVideo(opts: VideoOpts): Promise<GenerateResult>
  generateAudio?(opts: AudioOpts): Promise<GenerateResult>
  generateMusic?(opts: MusicOpts): Promise<GenerateResult>
  editImage?(opts: ImageEditOpts): Promise<GenerateResult>
  upscaleImage?(opts: ImageUpscaleOpts): Promise<GenerateResult>
}
