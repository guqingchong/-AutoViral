import { getAccountCredential } from "../db/account-credentials-repo.js";
import { getCredential } from "../db/platform-credentials-repo.js";
import { getDb } from "../db/connection.js";

/** UI/账号体系键 → 凭证存储键(wechat_mp 是 UI 侧键,凭证统一存 wechat) */
export function normalizePlatformKey(platform: string): string {
  return platform === "wechat_mp" ? "wechat" : platform;
}

/**
 * 凭证解析(2026-08-20 方案A):指定账号 > 平台默认账号 > 平台任一活跃账号(告警)
 * > 旧 platform_credentials(deprecated 兜底,矩阵改造过渡期保留)。
 */
export function resolveAccountCredential(
  platform: string,
  accountId: string | undefined,
  keyType: string,
): string | undefined {
  const db = getDb();
  if (accountId) {
    const v = getAccountCredential(accountId, keyType);
    if (v) return v;
  }
  const def = db.prepare(
    "SELECT id FROM accounts WHERE platform = ? AND is_default = 1 AND (status IS NULL OR status = 'active') LIMIT 1"
  ).get(platform) as { id: string } | undefined;
  if (def) {
    const v = getAccountCredential(def.id, keyType);
    if (v) return v;
  }
  const any = db.prepare(
    "SELECT id FROM accounts WHERE platform = ? AND (status IS NULL OR status = 'active') ORDER BY created_at ASC LIMIT 1"
  ).get(platform) as { id: string } | undefined;
  if (any && any.id !== def?.id) {
    const v = getAccountCredential(any.id, keyType);
    if (v) {
      console.warn(`[credential-resolver] ${platform} 无默认账号凭证,回落活跃账号 ${any.id}`);
      return v;
    }
  }
  // deprecated 兜底:旧表(键已归一)
  return getCredential(normalizePlatformKey(platform), keyType);
}
