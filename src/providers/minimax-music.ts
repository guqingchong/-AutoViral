import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir } from '../config.js'
import { probeMedia } from '../video/ffmpeg.js'
import type { GenerateProvider, ImageOpts, VideoOpts, AudioOpts, MusicOpts, GenerateResult } from './base.js'

const execFileAsync = promisify(execFile)

const MINIMAX_MUSIC_URL = 'https://api.minimax.chat/v1/music_generation'
// 2026-08-14: music-1.5 → music-2.6(与 skills/asset-generation/scripts/music_generate.py 对齐),
// 1.5 产物音质/编曲明显粗糙,是"BGM 质量差"的直接原因
const DEFAULT_MODEL = 'music-2.6'
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
    const { prompt, lyrics, workId, filename, duration } = opts

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

      // MiniMax 不接受时长参数,产物长度由模型决定(实测常只有 20-45s)。
      // 调用方传入期望时长时,不足则无缝循环补齐并在末尾 3s 淡出,
      // 避免下游被迫用 yt-dlp 抓免版权音乐兜底(版权风险)。
      if (duration && duration > 0) {
        try {
          await this.ensureDuration(assetPath, duration)
        } catch (err) {
          console.warn('[minimax-music] 时长补齐失败,保留原始时长产物:', err instanceof Error ? err.message : err)
        }
      }

      return {
        success: true,
        assetPath,
        previewUrl: `/api/works/${workId}/assets/audio/${outFilename}`,
      }
    } catch (err: any) {
      return { success: false, error: err.message, code: 'API_ERROR' }
    }
  }

  /**
   * 时长补齐:实际时长低于目标时,单曲循环拼接到目标时长,末尾 3s 淡出。
   * 纯器乐 BGM 循环听感可接受;带歌词歌曲不适用(但歌曲一般也不会偏短)。
   */
  private async ensureDuration(assetPath: string, target: number): Promise<void> {
    const info = await probeMedia(assetPath)
    const actual = info.duration ?? 0
    if (actual >= target - 1) return // 达标(容忍 1s 误差)
    const tmp = assetPath.replace(/\.mp3$/i, '.loop.mp3')
    const fadeStart = Math.max(0, target - 3)
    await execFileAsync('ffmpeg', [
      '-y', '-stream_loop', '-1', '-i', assetPath,
      '-t', String(target),
      '-af', `afade=t=out:st=${fadeStart}:d=3`,
      '-codec:a', 'libmp3lame', '-q:a', '2', tmp,
    ], { timeout: 120_000 })
    await rename(tmp, assetPath)
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
