// MiniMax H3 本地视频生成 provider(AutoDL 4090 + ComfyUI)
// PoC 验证: poc/local-gen/(2026-08-10,目检通过)
// 设计文档: docs/superpowers/specs/2026-08-12-minimax-h3-integration-design.md
//
// 链路: SSH 隧道(8188) → POST /prompt(模板化 API 图) → 轮询 /history/{id}
//       → GET /view 下载产物到 works/<workId>/assets/clips/
// 单条约 210s / ¥0.13(对比即梦 ¥1.4),24fps,480×864 竖屏,原生 32kHz 立体声音轨

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dataDir, getConfig } from '../config.js'
import { downloadFile } from './_volcengine-cv.js'
import { checkH3Health, recordH3Activity } from '../services/h3-instance-service.js'
import { ensureH3Tunnel } from '../services/h3-tunnel-service.js'
import type { GenerateProvider, ImageOpts, VideoOpts, GenerateResult } from './base.js'

// ── 模型文件(PoC 实例已下载,见 poc/local-gen/README.md)────────────────────
const UNET = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
const CLIP = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
const VIDEO_VAE = 'minimax_h3_video_vae_fp16.safetensors'
const AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'

const FPS = 24
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 10 * 60_000   // PoC 单条 ~210s,排队留余量
const MAX_GENERATE_ATTEMPTS = 2       // 生成失败重试 1 次
const MAX_DOWNLOAD_ATTEMPTS = 3       // 下载失败重试 2 次

/** 时长(秒) → 17k+5 网格帧数(与 PoC build_workflow.py 一致: 5s → 124) */
function framesForSeconds(sec: number): number {
  const raw = Math.max(5, Math.round(sec * FPS))
  return raw + ((5 - (raw % 17)) % 17)
}

/**
 * shotType 音轨约定(设计文档 §3.1):H3 原生音画同生,需在 prompt 中声明音频意图。
 * dialogue 的台词由调用方写入 prompt(如「主持人开口说:…」),provider 不追加;
 * 其余镜头统一追加"无对白"约束,防止模型自作主张生成语音(一期/合成期统一处理)。
 */
function applyShotTypePrompt(prompt: string, shotType?: VideoOpts['shotType']): string {
  switch (shotType) {
    case 'dialogue':
      return prompt
    case 'broll':
      return `${prompt}\n\n音频:无对白、无旁白、无人声,仅自然环境音。`
    case 'narration':
      return `${prompt}\n\n音频:无对白、无旁白、无人声,安静画面,仅轻微环境音。`
    case 'hero':
      return `${prompt}\n\n音频:无对白、无旁白、无人声。`
    default:
      return prompt
  }
}

/** 画幅 → 宽高。H3 原生短边 768 上限,PoC 验证用 480×864 竖屏(≈9:16) */
function resolveSize(opts: VideoOpts): { width: number; height: number } {
  const ratio = opts.ratio ?? opts.resolution ?? '9:16'
  return ratio === '16:9' ? { width: 864, height: 480 } : { width: 480, height: 864 }
}

/** 构建 ComfyUI API 图(PoC api_*.json 的模板化)。传 uploadedFirstFrame 则走 i2v */
function buildWorkflow(opts: {
  prompt: string
  width: number
  height: number
  length: number
  seed: number
  filenamePrefix: string
  uploadedFirstFrame?: string
}): Record<string, unknown> {
  const h3Inputs: Record<string, unknown> = {
    clip: ['13', 0],
    vae: ['11', 0],
    prompt: opts.prompt,
    width: opts.width,
    height: opts.height,
    length: opts.length,
  }
  const graph: Record<string, unknown> = {
    '6': { class_type: 'UNETLoader', inputs: { unet_name: UNET, weight_dtype: 'default' } },
    '13': { class_type: 'CLIPLoader', inputs: { clip_name: CLIP, type: 'minimax', device: 'default' } },
    '11': { class_type: 'VAELoader', inputs: { vae_name: VIDEO_VAE } },
    '24': { class_type: 'VAELoader', inputs: { vae_name: AUDIO_VAE } },
    '104': { class_type: 'MiniMaxH3ImageToVideo', inputs: h3Inputs },
    '15': { class_type: 'RandomNoise', inputs: { noise_seed: opts.seed } },
    '17': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '9': { class_type: 'BasicScheduler', inputs: { model: ['6', 0], scheduler: 'simple', steps: 20, denoise: 1.0 } },
    '16': { class_type: 'BasicGuider', inputs: { model: ['6', 0], conditioning: ['104', 0] } },
    '14': {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['15', 0], guider: ['16', 0], sampler: ['17', 0], sigmas: ['9', 0], latent_image: ['104', 1] },
    },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['14', 0], vae: ['11', 0] } },
    '23': { class_type: 'VAEDecodeAudio', inputs: { samples: ['14', 0], vae: ['24', 0] } },
    '91': { class_type: 'CreateVideo', inputs: { images: ['10', 0], fps: FPS, audio: ['23', 0], bit_depth: 8 } },
    '92': { class_type: 'SaveVideo', inputs: { video: ['91', 0], filename_prefix: opts.filenamePrefix, format: 'auto', codec: 'auto' } },
  }
  // i2v: 首帧图片先上传到 ComfyUI,再经 LoadImage 节点接入
  if (opts.uploadedFirstFrame) {
    graph['200'] = { class_type: 'LoadImage', inputs: { image: opts.uploadedFirstFrame } }
    h3Inputs.first_frame = ['200', 0]
  }
  return graph
}

export class LocalH3Provider implements GenerateProvider {
  readonly name = 'local-h3'
  readonly supportsImage = false
  readonly supportsVideo = true

  private baseUrl: string
  private pollIntervalMs: number
  private pollTimeoutMs: number

  constructor(config: { baseUrl: string; pollIntervalMs?: number; pollTimeoutMs?: number }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    // 轮询间隔/超时可注入,仅测试需要覆盖
    this.pollIntervalMs = config.pollIntervalMs ?? POLL_INTERVAL_MS
    this.pollTimeoutMs = config.pollTimeoutMs ?? POLL_TIMEOUT_MS
  }

  async generateImage(_opts: ImageOpts): Promise<GenerateResult> {
    return {
      success: false,
      error: 'local-h3 provider 仅支持视频生成,图片请使用 jimeng/openrouter provider',
      code: 'INVALID_PARAMS',
    }
  }

  /** 实例离线时返回的固定文案:eco 档调用方据此阻塞并显著提醒用户开机 */
  private offlineError(): GenerateResult {
    return {
      success: false,
      error: 'H3 实例离线(AutoDL ComfyUI 不可达)。请到 AutoDL 控制台开机实例并启动 ComfyUI;eco 档禁用云端视频生成,任务在此阻塞,实例上线后请重试。',
      code: 'INSTANCE_OFFLINE',
    }
  }

  /** firstFrame(URL 或本地路径)→ 上传到 ComfyUI input 目录,返回上传后的文件名 */
  private async uploadFirstFrame(firstFrame: string): Promise<string> {
    let bytes: Buffer
    let name = 'h3-first-frame.png'
    if (firstFrame.startsWith('http://') || firstFrame.startsWith('https://')) {
      const res = await fetch(firstFrame)
      if (!res.ok) throw new Error(`Download failed: firstFrame ${res.status} ${res.statusText}`)
      bytes = Buffer.from(await res.arrayBuffer())
      name = basename(new URL(firstFrame).pathname) || name
    } else {
      bytes = await readFile(firstFrame)
      name = basename(firstFrame)
    }
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(bytes)]), name)
    form.append('overwrite', 'true')
    const res = await fetch(`${this.baseUrl}/upload/image`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`Upload firstFrame failed: ${res.status} ${res.statusText}`)
    const data = (await res.json()) as { name?: string }
    if (!data.name) throw new Error('Upload firstFrame: no name in ComfyUI response')
    return data.name
  }

  /** 提交一次生成并轮询到完成,返回产物文件描述 */
  private async submitAndPoll(graph: Record<string, unknown>): Promise<{ filename: string; subfolder: string; type: string }> {
    const submitRes = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph }),
    })
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => '')
      throw new Error(`ComfyUI submit failed: ${submitRes.status} ${text.slice(0, 300)}`)
    }
    const submitData = (await submitRes.json()) as { prompt_id?: string; error?: unknown }
    const promptId = submitData.prompt_id
    if (!promptId) throw new Error(`ComfyUI submit: no prompt_id (${JSON.stringify(submitData).slice(0, 300)})`)

    const deadline = Date.now() + this.pollTimeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs))
      const histRes = await fetch(`${this.baseUrl}/history/${promptId}`)
      if (!histRes.ok) continue
      const hist = (await histRes.json()) as Record<string, any>
      const entry = hist[promptId]
      if (!entry) continue

      if (entry.status?.status_str === 'error') {
        const msgs = (entry.status?.messages ?? [])
          .map((m: any) => (Array.isArray(m) ? m[1] : m))
          .map((m: any) => m?.exception_message ?? m?.message ?? JSON.stringify(m))
          .join('; ')
        throw new Error(`ComfyUI execution error: ${msgs.slice(0, 500)}`)
      }
      if (!entry.status?.completed) continue

      // 在 outputs 里找 SaveVideo 产物
      // (新版 ComfyUI SaveVideo 把 mp4 放在 images 数组 + animated 标记,旧版用 video/gifs)
      for (const nodeOut of Object.values(entry.outputs ?? {}) as any[]) {
        const videos = nodeOut?.video ?? nodeOut?.gifs ?? nodeOut?.images
        if (Array.isArray(videos) && videos.length > 0) {
          const v = videos[0]
          return { filename: v.filename, subfolder: v.subfolder ?? '', type: v.type ?? 'output' }
        }
      }
      throw new Error('ComfyUI completed but no video output found')
    }
    throw new Error('Task timed out after 10 minutes')
  }

  private async downloadOutput(file: { filename: string; subfolder: string; type: string }, destPath: string): Promise<void> {
    const url = `${this.baseUrl}/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder)}&type=${encodeURIComponent(file.type)}`
    let lastErr: unknown
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        await downloadFile(url, destPath)
        return
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr
  }

  async generateVideo(opts: VideoOpts): Promise<GenerateResult> {
    const { prompt, workId, filename } = opts

    if (!prompt || prompt.length === 0) {
      return { success: false, error: 'prompt 不能为空', code: 'INVALID_PARAMS' }
    }

    // 实例可达性:隧道 + 健康探测,离线则快速失败(eco 档由调用方阻塞提醒)
    if (!(await ensureH3Tunnel()) || !(await checkH3Health())) {
      return this.offlineError()
    }

    const { width, height } = resolveSize(opts)
    const length = framesForSeconds(opts.duration ?? 5)
    const filenamePrefix = `h3/${workId}-${basename(filename, '.mp4')}`

    try {
      // i2v: 上传首帧;t2v(dialogue 镜头优先)不传
      let uploadedFirstFrame: string | undefined
      if (opts.firstFrame) {
        uploadedFirstFrame = await this.uploadFirstFrame(opts.firstFrame)
      }

      let lastErr: unknown
      for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt++) {
        try {
          const graph = buildWorkflow({
            prompt: applyShotTypePrompt(prompt, opts.shotType),
            width,
            height,
            length,
            seed: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
            filenamePrefix,
            uploadedFirstFrame,
          })
          const output = await this.submitAndPoll(graph)
          const assetPath = join(dataDir, 'works', workId, 'assets', filename)
          await this.downloadOutput(output, assetPath)
          recordH3Activity()
          return {
            success: true,
            assetPath,
            previewUrl: `/api/works/${workId}/assets/${filename}`,
          }
        } catch (err) {
          lastErr = err
        }
      }
      throw lastErr
    } catch (err: any) {
      const message: string = err?.message ?? String(err)
      if (message.includes('timed out')) {
        return { success: false, error: message, code: 'TIMEOUT' }
      }
      if (message.includes('Download failed')) {
        return { success: false, error: message, code: 'DOWNLOAD_FAILED' }
      }
      // 连接层故障(ECONNREFUSED 等)按实例离线处理,提示语义更准确
      if (message.includes('ECONNREFUSED') || message.includes('fetch failed') || message.includes('ETIMEDOUT')) {
        return this.offlineError()
      }
      return { success: false, error: message, code: 'API_ERROR' }
    }
  }
}
