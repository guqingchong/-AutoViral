import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { dataDir } from '../config.js'
import { submitAndPoll, downloadFile } from './_volcengine-cv.js'
import type {
  GenerateProvider,
  ImageOpts,
  VideoOpts,
  ImageEditOpts,
  ImageUpscaleOpts,
  GenerateResult,
} from './base.js'

// 即梦图 4.6:文生图 + 图生图(0-14 张参考)，与 Seedream 4.0 同源
const IMAGE_REQ_KEY = 'jimeng_seedream46_cvtob'
// Video 3.0 Pro uses a unified req_key for both T2V and I2V
const VIDEO_T2V_REQ_KEY = 'jimeng_ti2v_v30_pro'
const VIDEO_I2V_REQ_KEY = 'jimeng_ti2v_v30_pro'
// 局部重绘 / 消除笔(原图 + mask 双图输入)
const INPAINT_REQ_KEY = 'jimeng_image2image_dream_inpaint'
// 智能超清(seed3 tile-sr,4K/8K 升清)
const UPSCALE_REQ_KEY = 'jimeng_i2i_seed3_tilesr_cvtob'

const isUrl = (s: string) => s.startsWith('http://') || s.startsWith('https://')

export class JimengProvider implements GenerateProvider {
  readonly name = 'jimeng'
  readonly supportsImage = true
  readonly supportsVideo = true
  readonly supportsImageEdit = true
  readonly supportsImageUpscale = true

  private accessKey: string
  private secretKey: string

  constructor(config: { accessKey: string; secretKey: string }) {
    this.accessKey = config.accessKey
    this.secretKey = config.secretKey
  }

  // 把响应里的 image_url / base64 落盘到 works/<workId>/assets/images/<filename>
  private async _saveImage(
    data: any,
    workId: string,
    filename: string,
  ): Promise<GenerateResult> {
    const imageUrl = data?.image_urls?.[0] ?? data?.resp_data?.[0]?.image_url
    const imageBase64 = data?.binary_data_base64?.[0]

    const assetPath = join(dataDir, 'works', workId, 'assets', 'images', filename)

    if (imageUrl) {
      await downloadFile(imageUrl, assetPath)
    } else if (imageBase64) {
      await mkdir(dirname(assetPath), { recursive: true })
      await writeFile(assetPath, Buffer.from(imageBase64, 'base64'))
    } else {
      return { success: false, error: 'No image URL or base64 data in response', code: 'API_ERROR' }
    }

    return {
      success: true,
      assetPath,
      previewUrl: `/api/works/${workId}/assets/images/${filename}`,
    }
  }

  private _mapError(err: any): GenerateResult {
    if (err.message?.includes('timed out')) {
      return { success: false, error: err.message, code: 'TIMEOUT' }
    }
    if (err.message?.includes('Download failed')) {
      return { success: false, error: err.message, code: 'DOWNLOAD_FAILED' }
    }
    if (err.message?.includes('Access Denied')) {
      return {
        success: false,
        error: '即梦能力权限未开通。请前往火山引擎控制台 (console.volcengine.com) 开通对应能力后重试。',
        code: 'ACCESS_DENIED',
      }
    }
    return { success: false, error: err.message, code: 'API_ERROR' }
  }

  async generateImage(opts: ImageOpts): Promise<GenerateResult> {
    const { workId, filename } = opts
    let prompt = opts.prompt

    if (!prompt || prompt.length === 0) {
      return { success: false, error: 'prompt 不能为空', code: 'INVALID_PARAMS' }
    }

    // Auto-enhance prompt with quality keywords if not already present
    const qualityKeywords = ['high quality', 'professional', 'detailed', '4K', 'sharp focus', 'masterpiece', 'best quality']
    const hasQuality = qualityKeywords.some(kw => prompt.toLowerCase().includes(kw.toLowerCase()))
    if (!hasQuality) {
      prompt = prompt + ', high quality, professional, detailed, sharp focus, best quality, masterpiece'
    }
    if (prompt.length > 800) {
      prompt = prompt.slice(0, 800)
    }

    try {
      const payload: Record<string, unknown> = {
        req_key: IMAGE_REQ_KEY,
        prompt,
        force_single: true,    // 默认强制单图,降低延迟和成本(用户决策)
      }

      // width/height 同时给且都合规才使用,否则不传(模型按默认 size=4194304 + 智能比例)
      if (opts.width && opts.height) {
        payload.width = Math.min(4096, Math.max(1024, opts.width))
        payload.height = Math.min(4096, Math.max(1024, opts.height))
      }

      // 参考图合并:新 referenceImages(URL 列表) 优先,老 referenceImage 兼容
      const refs: string[] = []
      if (opts.referenceImages?.length) refs.push(...opts.referenceImages)
      if (opts.referenceImage) {
        if (isUrl(opts.referenceImage)) {
          refs.push(opts.referenceImage)
        } else {
          payload.binary_data_base64 = [opts.referenceImage]
        }
      }
      if (refs.length > 0) payload.image_urls = refs.slice(0, 14)

      const result = await submitAndPoll(this.accessKey, this.secretKey, payload)
      return await this._saveImage(result.data, workId, filename)
    } catch (err: any) {
      return this._mapError(err)
    }
  }

  async editImage(opts: ImageEditOpts): Promise<GenerateResult> {
    const { prompt, originalImage, maskImage, workId, filename } = opts

    if (!prompt || prompt.length === 0) {
      return { success: false, error: 'prompt 不能为空(消除场景请传 "删除")', code: 'INVALID_PARAMS' }
    }
    if (prompt.length > 120) {
      return { success: false, error: 'prompt 过长(限制 120 字符)', code: 'INVALID_PARAMS' }
    }
    if (!originalImage || !maskImage) {
      return { success: false, error: 'originalImage 和 maskImage 都必填', code: 'INVALID_PARAMS' }
    }

    try {
      const payload: Record<string, unknown> = {
        req_key: INPAINT_REQ_KEY,
        prompt,
      }

      // 两张图必须同种来源(URL 或 base64),且尺寸需一致(由调用方保证)
      if (isUrl(originalImage) && isUrl(maskImage)) {
        payload.image_urls = [originalImage, maskImage]
      } else if (!isUrl(originalImage) && !isUrl(maskImage)) {
        payload.binary_data_base64 = [originalImage, maskImage]
      } else {
        return {
          success: false,
          error: 'originalImage 和 maskImage 必须同时为 URL 或同时为 base64',
          code: 'INVALID_PARAMS',
        }
      }

      if (opts.seed !== undefined) payload.seed = opts.seed

      const result = await submitAndPoll(this.accessKey, this.secretKey, payload)
      return await this._saveImage(result.data, workId, filename)
    } catch (err: any) {
      return this._mapError(err)
    }
  }

  async upscaleImage(opts: ImageUpscaleOpts): Promise<GenerateResult> {
    const { originalImage, workId, filename } = opts

    if (!originalImage) {
      return { success: false, error: 'originalImage 不能为空', code: 'INVALID_PARAMS' }
    }

    try {
      const payload: Record<string, unknown> = {
        req_key: UPSCALE_REQ_KEY,
      }
      if (isUrl(originalImage)) {
        payload.image_urls = [originalImage]
      } else {
        payload.binary_data_base64 = [originalImage]
      }
      if (opts.resolution) payload.resolution = opts.resolution
      if (opts.scale !== undefined) payload.scale = opts.scale

      const result = await submitAndPoll(this.accessKey, this.secretKey, payload)
      return await this._saveImage(result.data, workId, filename)
    } catch (err: any) {
      return this._mapError(err)
    }
  }

  async generateVideo(opts: VideoOpts): Promise<GenerateResult> {
    const { prompt, workId, filename } = opts

    try {
      const isImageToVideo = !!opts.firstFrame
      const reqKey = isImageToVideo ? VIDEO_I2V_REQ_KEY : VIDEO_T2V_REQ_KEY

      const payload: Record<string, unknown> = {
        req_key: reqKey,
        prompt,
        return_url: true,
      }

      if (opts.firstFrame) {
        if (isUrl(opts.firstFrame)) {
          payload.image_urls = [opts.firstFrame]
        } else {
          payload.binary_data_base64 = [opts.firstFrame]
        }
      }
      if (opts.lastFrame) {
        if (isUrl(opts.lastFrame)) {
          if (payload.image_urls) {
            (payload.image_urls as string[]).push(opts.lastFrame)
          } else {
            payload.image_urls = [opts.lastFrame]
          }
        } else {
          payload.binary_data_base64 = payload.binary_data_base64 ?? []
          ;(payload.binary_data_base64 as string[]).push(opts.lastFrame)
        }
      }
      if (opts.resolution) {
        payload.aspect_ratio = opts.resolution
      }

      const result = await submitAndPoll(this.accessKey, this.secretKey, payload)

      const videoUrl = result.data?.video_urls?.[0]
        ?? result.data?.video_url
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
          error: '即梦视频生成权限未开通。请前往火山引擎控制台 (console.volcengine.com) 开通「CV/即梦视频生成」权限后重试。',
          code: 'ACCESS_DENIED',
        }
      }
      return { success: false, error: err.message, code: 'API_ERROR' }
    }
  }
}
