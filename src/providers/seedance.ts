import { join } from 'node:path'
import { dataDir } from '../config.js'
import { submitAndPoll, downloadFile } from './_volcengine-cv.js'
import type { GenerateProvider, ImageOpts, VideoOpts, GenerateResult } from './base.js'

// 小云雀 Seedance 2.0 fast 720p 两套 req_key:
// - 无视频参考: pippit_iv2v_v20_cvtob (仍可传 img_url_list 作图参考)
// - 有视频参考: pippit_iv2v_v20_cvtob_with_vinput (img + video 参考都支持)
const REQ_KEY_NO_VIDEO_REF = 'pippit_iv2v_v20_cvtob'
const REQ_KEY_WITH_VIDEO_REF = 'pippit_iv2v_v20_cvtob_with_vinput'

export class SeedanceProvider implements GenerateProvider {
  readonly name = 'seedance'
  readonly supportsImage = false
  readonly supportsVideo = true

  private accessKey: string
  private secretKey: string

  constructor(config: { accessKey: string; secretKey: string }) {
    this.accessKey = config.accessKey
    this.secretKey = config.secretKey
  }

  async generateImage(_opts: ImageOpts): Promise<GenerateResult> {
    return {
      success: false,
      error: 'Seedance provider 仅支持视频生成，请使用 jimeng provider 生成图片',
      code: 'INVALID_PARAMS',
    }
  }

  async generateVideo(opts: VideoOpts): Promise<GenerateResult> {
    const { prompt, workId, filename } = opts

    if (!prompt || prompt.length === 0) {
      return { success: false, error: 'prompt 不能为空', code: 'INVALID_PARAMS' }
    }
    if (prompt.length > 2000) {
      return { success: false, error: 'prompt 过长（限制 2000 字符）', code: 'INVALID_PARAMS' }
    }

    // 兼容 firstFrame: 老调用方式如果传了 firstFrame URL,作为参考图加入
    const referenceImages = [...(opts.referenceImages ?? [])]
    if (opts.firstFrame && (opts.firstFrame.startsWith('http://') || opts.firstFrame.startsWith('https://'))) {
      referenceImages.push(opts.firstFrame)
    }
    const referenceVideos = opts.referenceVideos ?? []

    // 有视频参考 → 切到 with_vinput req_key
    const reqKey = referenceVideos.length > 0 ? REQ_KEY_WITH_VIDEO_REF : REQ_KEY_NO_VIDEO_REF

    try {
      const payload: Record<string, unknown> = {
        req_key: reqKey,
        prompt,
        enable_watermark: false, // 默认覆盖文档默认值(true) → 关水印
      }

      if (referenceImages.length > 0) {
        payload.img_url_list = referenceImages
      }
      if (referenceVideos.length > 0) {
        payload.video_url_list = referenceVideos
      }
      if (opts.ratio) {
        payload.ratio = opts.ratio
      }
      if (opts.durationHint) {
        payload.duration = opts.durationHint
      }
      if (opts.language) {
        payload.language = opts.language
      }

      const result = await submitAndPoll(this.accessKey, this.secretKey, payload)

      const videoUrl = result.data?.video_url
        ?? result.data?.video_urls?.[0]
        ?? result.data?.resp_data?.[0]?.video_url

      if (!videoUrl) {
        return { success: false, error: 'No video URL in response', code: 'API_ERROR' }
      }

      const assetPath = join(dataDir, 'works', workId, 'assets', 'clips', filename)
      await downloadFile(videoUrl, assetPath)

      return {
        success: true,
        assetPath,
        previewUrl: `/api/works/${workId}/assets/clips/${filename}`,
      }
    } catch (err: any) {
      if (err.message?.includes('timed out')) {
        return { success: false, error: err.message, code: 'TIMEOUT' }
      }
      if (err.message?.includes('Download failed')) {
        return { success: false, error: err.message, code: 'DOWNLOAD_FAILED' }
      }
      if (err.message?.includes('Access Denied')) {
        return {
          success: false,
          error: 'Seedance 视频生成权限未开通。请前往火山引擎控制台 (console.volcengine.com) → 智能视觉 → 模型广场 → 小云雀 → Seedance 2.0 fast 720p 开通服务后重试。',
          code: 'ACCESS_DENIED',
        }
      }
      return { success: false, error: err.message, code: 'API_ERROR' }
    }
  }
}
