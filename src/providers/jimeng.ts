import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { dataDir } from '../config.js'
import { submitAndPoll, downloadFile } from './_volcengine-cv.js'
import type { GenerateProvider, ImageOpts, VideoOpts, GenerateResult } from './base.js'

const IMAGE_REQ_KEY = 'jimeng_t2i_v30'
// Video 3.0 Pro uses a unified req_key for both T2V and I2V
const VIDEO_T2V_REQ_KEY = 'jimeng_ti2v_v30_pro'
const VIDEO_I2V_REQ_KEY = 'jimeng_ti2v_v30_pro'

export class JimengProvider implements GenerateProvider {
  readonly name = 'jimeng'
  readonly supportsImage = true
  readonly supportsVideo = true

  private accessKey: string
  private secretKey: string

  constructor(config: { accessKey: string; secretKey: string }) {
    this.accessKey = config.accessKey
    this.secretKey = config.secretKey
  }

  async generateImage(opts: ImageOpts): Promise<GenerateResult> {
    const { prompt, workId, filename } = opts
    const width = opts.width ?? 1088
    const height = opts.height ?? 1088

    const clampedWidth = Math.min(1728, Math.max(576, width))
    const clampedHeight = Math.min(1728, Math.max(576, height))

    try {
      const payload: Record<string, unknown> = {
        req_key: IMAGE_REQ_KEY,
        prompt,
        width: clampedWidth,
        height: clampedHeight,
        return_url: true,
        logo_info: { add_logo: false },
      }

      if (opts.referenceImage) {
        payload.binary_data_base64 = [opts.referenceImage]
      }

      const result = await submitAndPoll(this.accessKey, this.secretKey, payload)

      const imageUrl = result.data?.image_urls?.[0]
        ?? result.data?.resp_data?.[0]?.image_url
      const imageBase64 = result.data?.binary_data_base64?.[0]

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
    } catch (err: any) {
      if (err.message?.includes('timed out')) {
        return { success: false, error: err.message, code: 'TIMEOUT' }
      }
      if (err.message?.includes('Download failed')) {
        return { success: false, error: err.message, code: 'DOWNLOAD_FAILED' }
      }
      return { success: false, error: err.message, code: 'API_ERROR' }
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
        if (opts.firstFrame.startsWith('http://') || opts.firstFrame.startsWith('https://')) {
          payload.image_urls = [opts.firstFrame]
        } else {
          payload.binary_data_base64 = [opts.firstFrame]
        }
      }
      if (opts.lastFrame) {
        if (opts.lastFrame.startsWith('http://') || opts.lastFrame.startsWith('https://')) {
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
