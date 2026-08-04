import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dataDir } from '../config.js'
import type { GenerateProvider, ImageOpts, VideoOpts, AudioOpts, GenerateResult } from './base.js'

const MINIMAX_TTS_URL = 'https://api.minimax.chat/v1/t2a_v2'

// speech-01-turbo:听感最自然(02-turbo 默认 tempo 偏慢,在中文播报场景反而失真)
const DEFAULT_MODEL = 'speech-01-turbo'
// 项目用户为中文创作者(见 CLAUDE.md Design Context),默认走中文 boost
const DEFAULT_LANGUAGE_BOOST = 'Chinese'

export interface MiniMaxTTSConfig {
  apiKey: string
}

/**
 * 独立 TTS 合成函数：构造 payload → fetch → 解 hex → 写文件。
 * outPath 为绝对路径，父目录自行 mkdir。MiniMaxTTSProvider.generateAudio 复用它。
 */
export async function synthesizeToFile(apiKey: string, opts: {
  text: string; voice?: string; speed?: number; languageBoost?: string; outPath: string;
}): Promise<{ success: boolean; assetPath?: string; error?: string }> {
  const {
    text,
    voice = 'male-qn-qingse',
    speed = 1,
    languageBoost = DEFAULT_LANGUAGE_BOOST,
    outPath,
  } = opts

  try {
    const payload = {
      model: DEFAULT_MODEL,
      text,
      stream: false,
      language_boost: languageBoost,
      voice_setting: {
        voice_id: voice,
        speed,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
    }

    const res = await fetch(MINIMAX_TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const errBody = await res.text()
      return { success: false, error: `MiniMax API error ${res.status}: ${errBody}` }
    }

    const data = await res.json() as any
    const audioHex = data.data?.audio

    if (!audioHex || typeof audioHex !== 'string') {
      return { success: false, error: 'No audio data in MiniMax response' }
    }

    const buffer = Buffer.from(audioHex, 'hex')
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, buffer)

    return { success: true, assetPath: outPath }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

export class MiniMaxTTSProvider implements GenerateProvider {
  readonly name = 'minimax-tts'
  readonly supportsImage = false
  readonly supportsVideo = false
  readonly supportsAudio = true

  private apiKey: string

  constructor(config: MiniMaxTTSConfig) {
    this.apiKey = config.apiKey
  }

  async generateAudio(opts: AudioOpts): Promise<GenerateResult> {
    const {
      text,
      voice,
      speed,
      languageBoost,
      workId,
      filename,
    } = opts

    const outFilename = filename.endsWith('.mp3') ? filename : `${filename}.mp3`
    const assetPath = join(dataDir, 'works', workId, 'assets', 'audio', outFilename)

    const result = await synthesizeToFile(this.apiKey, {
      text, voice, speed, languageBoost, outPath: assetPath,
    })

    if (!result.success) {
      return { success: false, error: result.error, code: 'API_ERROR' }
    }

    return {
      success: true,
      assetPath,
      previewUrl: `/api/works/${workId}/assets/audio/${outFilename}`,
    }
  }

  async generateImage(_opts: ImageOpts): Promise<GenerateResult> {
    return { success: false, error: 'MiniMax TTS does not support image generation', code: 'INVALID_PARAMS' }
  }

  async generateVideo(_opts: VideoOpts): Promise<GenerateResult> {
    return { success: false, error: 'MiniMax TTS does not support video generation', code: 'INVALID_PARAMS' }
  }
}
