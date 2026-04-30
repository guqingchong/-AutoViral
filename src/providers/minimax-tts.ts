import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../config.js'
import type { GenerateProvider, ImageOpts, VideoOpts, AudioOpts, GenerateResult } from './base.js'

const MINIMAX_TTS_URL = 'https://api.minimax.chat/v1/t2a_v2'

export interface MiniMaxTTSConfig {
  apiKey: string
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
    const { text, voice = 'male-qn-qingse', speed = 1, workId, filename } = opts

    try {
      const outFilename = filename.endsWith('.mp3') ? filename : `${filename}.mp3`
      const assetPath = join(dataDir, 'works', workId, 'assets', 'audio', outFilename)

      const payload = {
        model: 'speech-01-turbo',
        text,
        stream: false,
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
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const errBody = await res.text()
        return { success: false, error: `MiniMax API error ${res.status}: ${errBody}`, code: 'API_ERROR' }
      }

      const data = await res.json() as any
      const audioHex = data.data?.audio

      if (!audioHex || typeof audioHex !== 'string') {
        return { success: false, error: 'No audio data in MiniMax response', code: 'API_ERROR' }
      }

      const buffer = Buffer.from(audioHex, 'hex')
      const dir = join(dataDir, 'works', workId, 'assets', 'audio')
      await mkdir(dir, { recursive: true })
      await writeFile(assetPath, buffer)

      return {
        success: true,
        assetPath,
        previewUrl: `/api/works/${workId}/assets/audio/${outFilename}`,
      }
    } catch (err: any) {
      return { success: false, error: err.message, code: 'API_ERROR' }
    }
  }

  async generateImage(_opts: ImageOpts): Promise<GenerateResult> {
    return { success: false, error: 'MiniMax TTS does not support image generation', code: 'INVALID_PARAMS' }
  }

  async generateVideo(_opts: VideoOpts): Promise<GenerateResult> {
    return { success: false, error: 'MiniMax TTS does not support video generation', code: 'INVALID_PARAMS' }
  }
}
