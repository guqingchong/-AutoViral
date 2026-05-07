import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { dataDir } from '../config.js'
import type { GenerateProvider, ImageOpts, VideoOpts, AudioOpts, MusicOpts, GenerateResult } from './base.js'

const MINIMAX_MUSIC_URL = 'https://api.minimax.chat/v1/music_generation'
const DEFAULT_MODEL = 'music-1.5'
const INSTRUMENTAL_MARKER = '[instrumental]'

export interface MiniMaxMusicConfig {
  apiKey: string
}

export class MiniMaxMusicProvider implements GenerateProvider {
  readonly name = 'minimax-music'
  readonly supportsImage = false
  readonly supportsVideo = false
  readonly supportsMusic = true

  private apiKey: string

  constructor(config: MiniMaxMusicConfig) {
    this.apiKey = config.apiKey
  }

  async generateMusic(opts: MusicOpts): Promise<GenerateResult> {
    const { prompt, lyrics, workId, filename } = opts

    try {
      const outFilename = filename.endsWith('.mp3') ? filename : `${filename}.mp3`
      const assetPath = join(dataDir, 'works', workId, 'assets', 'audio', outFilename)

      // BGM 模式 (无歌词) 必须用 [instrumental] 标记，空串会被拒
      const effectiveLyrics = lyrics?.trim() ? lyrics.trim() : INSTRUMENTAL_MARKER

      const payload = {
        model: DEFAULT_MODEL,
        lyrics: effectiveLyrics,
        prompt,
        audio_setting: {
          sample_rate: 44100,
          bitrate: 256000,
          format: 'mp3',
        },
      }

      const res = await fetch(MINIMAX_MUSIC_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const errBody = await res.text()
        return { success: false, error: `MiniMax music HTTP ${res.status}: ${errBody}`, code: 'API_ERROR' }
      }

      const data = await res.json() as any
      if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
        return {
          success: false,
          error: `MiniMax music API error ${data.base_resp.status_code}: ${data.base_resp.status_msg ?? ''}`,
          code: data.base_resp.status_code === 1004 ? 'ACCESS_DENIED' : 'API_ERROR',
        }
      }

      const audioHex = data.data?.audio
      if (!audioHex || typeof audioHex !== 'string') {
        return { success: false, error: 'No audio data in MiniMax music response', code: 'API_ERROR' }
      }

      const buffer = Buffer.from(audioHex, 'hex')
      await mkdir(dirname(assetPath), { recursive: true })
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
    return { success: false, error: 'MiniMax music does not support image generation', code: 'INVALID_PARAMS' }
  }

  async generateVideo(_opts: VideoOpts): Promise<GenerateResult> {
    return { success: false, error: 'MiniMax music does not support video generation', code: 'INVALID_PARAMS' }
  }

  async generateAudio(_opts: AudioOpts): Promise<GenerateResult> {
    return { success: false, error: 'MiniMax music provider does not handle TTS — use minimax-tts instead', code: 'INVALID_PARAMS' }
  }
}
