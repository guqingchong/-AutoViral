import type { GenerateProvider } from './base.js'
import { DreaminaProvider, isDreaminaAvailable } from './dreamina.js'
import { JimengProvider } from './jimeng.js'
import { SeedanceProvider } from './seedance.js'
import { NanoBananaProvider } from './nanobanana.js'
import { MiniMaxTTSProvider } from './minimax-tts.js'
import { MiniMaxMusicProvider } from './minimax-music.js'
import { LocalH3Provider } from './local-h3.js'

const providers = new Map<string, GenerateProvider>()

export function registerProvider(p: GenerateProvider) { providers.set(p.name, p) }
export function getProvider(name: string) { return providers.get(name) }

export function getDefaultProvider(type: 'image' | 'video' | 'audio' | 'music') {
  if (type === 'video') {
    const dreamina = providers.get('dreamina')
    if (dreamina) return dreamina
  }
  for (const p of providers.values()) {
    if (type === 'image' && p.supportsImage) return p
    if (type === 'video' && p.supportsVideo) return p
    if (type === 'audio' && p.supportsAudio) return p
    if (type === 'music' && p.supportsMusic) return p
  }
}

export function listProviders() {
  return [...providers.values()].map(p => ({
    name: p.name,
    image: p.supportsImage,
    video: p.supportsVideo,
    audio: p.supportsAudio,
    music: p.supportsMusic,
    imageEdit: p.supportsImageEdit,
    imageUpscale: p.supportsImageUpscale,
  }))
}

export async function initProviders(config: any) {
  // Dreamina CLI — preferred for video, check if logged in
  if (await isDreaminaAvailable()) {
    registerProvider(new DreaminaProvider())
  }
  if (config.jimeng?.accessKey) {
    registerProvider(new JimengProvider(config.jimeng))
    // Seedance 复用 jimeng 的 AK/SK(同一对火山智能视觉凭证)
    registerProvider(new SeedanceProvider(config.jimeng))
  }
  if (config.openrouter?.apiKey) registerProvider(new NanoBananaProvider(config.openrouter.apiKey))
  if (config.minimax?.apiKey) {
    registerProvider(new MiniMaxTTSProvider(config.minimax))
    registerProvider(new MiniMaxMusicProvider(config.minimax))
  }
  // MiniMax H3 本地视频生成(AutoDL ComfyUI,SSH 隧道);配置了 h3 段即启用
  if (config.h3?.baseUrl) {
    registerProvider(new LocalH3Provider({ baseUrl: config.h3.baseUrl }))
  }
}
