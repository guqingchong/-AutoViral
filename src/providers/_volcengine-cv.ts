// Volcengine 视觉智能服务（CV）共享层
// HMAC-SHA256 sigv4 签名 + 异步任务轮询 + 文件下载
// jimeng / seedance / 任何走 visual.volcengineapi.com 的 provider 共用

import { createHmac, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// ── 常量 ─────────────────────────────────────────────────────────────────────

export const BASE_URL = 'https://visual.volcengineapi.com'
export const REGION = 'cn-north-1'
export const SERVICE = 'cv'
export const API_VERSION = '2022-08-31'
export const SUBMIT_ACTION = 'CVSync2AsyncSubmitTask'
export const QUERY_ACTION = 'CVSync2AsyncGetResult'

const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes (Seedance 视频可能需要 5-10 分钟)

// ── 签名工具 ─────────────────────────────────────────────────────────────────

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function hmacSha256Hex(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex')
}

function getISODate(): { timestamp: string; dateStamp: string } {
  const now = new Date()
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = timestamp.slice(0, 8)
  return { timestamp, dateStamp }
}

export interface SignedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export function signRequest(
  accessKey: string,
  secretKey: string,
  action: string,
  payload: string,
): SignedRequest {
  const { timestamp, dateStamp } = getISODate()
  const host = 'visual.volcengineapi.com'
  const contentType = 'application/json'
  const payloadHash = sha256(payload)

  const queryParams = `Action=${action}&Version=${API_VERSION}`

  const canonicalHeaders = [
    `host:${host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${timestamp}`,
  ].join('\n') + '\n'

  const signedHeaders = 'host;x-content-sha256;x-date'

  const canonicalRequest = [
    'POST',
    '/',
    queryParams,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/request`
  const stringToSign = [
    'HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n')

  const kDate = hmacSha256(secretKey, dateStamp)
  const kRegion = hmacSha256(kDate, REGION)
  const kService = hmacSha256(kRegion, SERVICE)
  const kSigning = hmacSha256(kService, 'request')

  const signature = hmacSha256Hex(kSigning, stringToSign)

  const authorization = `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    url: `${BASE_URL}/?${queryParams}`,
    headers: {
      'Content-Type': contentType,
      'Host': host,
      'X-Date': timestamp,
      'X-Content-Sha256': payloadHash,
      'Authorization': authorization,
    },
    body: payload,
  }
}

// ── 提交+轮询 ───────────────────────────────────────────────────────────────

export async function submitAndPoll(
  accessKey: string,
  secretKey: string,
  submitPayload: Record<string, unknown>,
  onProgress?: (text: string) => void,
): Promise<{ data: any }> {
  const submitBody = JSON.stringify(submitPayload)
  const submitReq = signRequest(accessKey, secretKey, SUBMIT_ACTION, submitBody)
  const submitRes = await fetch(submitReq.url, {
    method: 'POST',
    headers: submitReq.headers,
    body: submitReq.body,
    signal: AbortSignal.timeout(30_000), // 批次6.4
  })
  const submitData = await submitRes.json() as any
  if (submitData.code && submitData.code !== 10000 && submitData.code !== 0) {
    throw new Error(`Submit failed: ${submitData.message ?? JSON.stringify(submitData)}`)
  }

  const taskId = submitData.data?.task_id
  if (!taskId) {
    if (submitData.data) return { data: submitData.data }
    throw new Error(`No task_id in response: ${JSON.stringify(submitData)}`)
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS
  let polls = 0
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    polls++
    // 批次4.3:轮询活性透出(此前 10 分钟零事件,UI 黑窗)
    onProgress?.(`云端生成中(已轮询 ${polls} 次,task ${taskId.slice(0, 12)}…)`)

    const queryPayload = JSON.stringify({ req_key: submitPayload.req_key, task_id: taskId })
    const queryReq = signRequest(accessKey, secretKey, QUERY_ACTION, queryPayload)
    const queryRes = await fetch(queryReq.url, {
      method: 'POST',
      headers: queryReq.headers,
      body: queryReq.body,
      signal: AbortSignal.timeout(15_000), // 批次6.4:单次查询挂起不再冻结轮询循环
    })
    const queryData = await queryRes.json() as any

    const status = queryData.data?.status
    if (status === 'done' || status === 'SUCCESS') {
      return { data: queryData.data }
    }
    if (status === 'failed' || status === 'FAILED' || status === 'expired' || status === 'not_found') {
      throw new Error(`Task ${status}: ${queryData.data?.message ?? queryData.message ?? JSON.stringify(queryData)}`)
    }
    // processing / in_queue / generating → continue polling
  }

  throw new Error('Task timed out after 5 minutes')
}

// ── 下载 ─────────────────────────────────────────────────────────────────────

export async function downloadFile(url: string, destPath: string): Promise<void> {
  // 批次6.4:下载加 120s 超时(此前无超时,隧道半开/对端挂起即无限等待)
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(destPath), { recursive: true })
  await writeFile(destPath, buffer)
}
