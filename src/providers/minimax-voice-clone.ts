const MINIMAX_BASE = 'https://api.minimax.chat'

export interface MiniMaxCloneConfig {
  apiKey: string
  groupId?: string
}

function withGroupId(url: string, cfg: MiniMaxCloneConfig): string {
  return cfg.groupId ? `${url}?GroupId=${encodeURIComponent(cfg.groupId)}` : url
}

async function parseBaseResp(res: Response): Promise<any> {
  const data = await res.json() as any
  const code = data?.base_resp?.status_code
  if (!res.ok || (code !== undefined && code !== 0)) {
    throw new Error(data?.base_resp?.status_msg ?? `MiniMax API error ${res.status}`)
  }
  return data
}

/** 上传克隆样本（purpose=voice_clone）→ file_id */
export async function uploadVoiceCloneFile(cfg: MiniMaxCloneConfig, buffer: Buffer, filename: string): Promise<number> {
  const form = new FormData()
  form.append('purpose', 'voice_clone')
  form.append('file', new Blob([new Uint8Array(buffer)]), filename)
  const res = await fetch(withGroupId(`${MINIMAX_BASE}/v1/files/upload`, cfg), { signal: AbortSignal.timeout(60_000), // 批次10.3

    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  })
  const data = await parseBaseResp(res)
  const fileId = data?.file?.file_id
  if (typeof fileId !== 'number') throw new Error('MiniMax 未返回 file_id')
  return fileId
}

/** 执行声音克隆，成功即可在 t2a_v2 中使用该 voice_id */
export async function cloneVoiceOnMiniMax(cfg: MiniMaxCloneConfig, fileId: number, voiceId: string): Promise<void> {
  const res = await fetch(withGroupId(`${MINIMAX_BASE}/v1/voice_clone`, cfg), { signal: AbortSignal.timeout(60_000),

    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_id: fileId,
      voice_id: voiceId,
      need_noise_reduction: true,
      need_volume_normalization: true,
    }),
  })
  await parseBaseResp(res)
}

/** 拉取 MiniMax 系统内置音色全量列表 */
export async function listSystemVoices(cfg: MiniMaxCloneConfig): Promise<Array<{ voice_id: string; name?: string; description?: string }>> {
  const res = await fetch(withGroupId(`${MINIMAX_BASE}/v1/get_voice`, cfg), { signal: AbortSignal.timeout(15_000),

    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_type: 'system' }),
  })
  const data = await parseBaseResp(res)
  return Array.isArray(data?.system_voice) ? data.system_voice : []
}
