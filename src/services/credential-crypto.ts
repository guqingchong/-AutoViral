import { randomUUID, createCipheriv, createDecipheriv, getCiphers, createHash } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte key from PUBLISH_CREDENTIALS_KEY or a dev fallback.
 * In production, always set PUBLISH_CREDENTIALS_KEY to a 64-char hex string (32 bytes).
 */
function getEncryptionKey(): Buffer {
  const secret = process.env.PUBLISH_CREDENTIALS_KEY;
  if (secret) {
    // Accept hex (64 chars = 32 bytes) or raw string (hashed to 32 bytes)
    if (/^[0-9a-f]{64}$/i.test(secret)) {
      return Buffer.from(secret, "hex");
    }
    // Hash to 32 bytes via SHA-256
    return createHash("sha256").update(secret, "utf-8").digest();
  }

  // Dev fallback — deterministic, logged to stderr in non-test environments
  if (!process.env.VITEST && !process.env.NODE_ENV?.startsWith("test")) {
    console.error(
      "[credential-crypto] WARNING: PUBLISH_CREDENTIALS_KEY not set. Using insecure dev fallback key."
    );
  }
  return createHash("sha256").update("autoviral-dev-fallback-key-2026", "utf-8").digest();
}

function assertAes256GcmSupported(): void {
  const ciphers = getCiphers();
  if (!ciphers.includes("aes-256-gcm")) {
    throw new Error("AES-256-GCM is not supported by this Node.js build");
  }
}

/**
 * Encrypt a plaintext object and return a JSON string containing the IV,
 * ciphertext (both hex), and auth tag (hex).
 */
export function encryptCredentials(plain: Record<string, unknown>): string {
  assertAes256GcmSupported();
  const key = getEncryptionKey();
  const iv = randomUUID().replace(/-/g, "").slice(0, IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const json = JSON.stringify(plain);
  let encrypted = cipher.update(json, "utf-8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return JSON.stringify({ iv, data: encrypted, tag: authTag });
}

/**
 * Decrypt a string previously returned by encryptCredentials back into the
 * original object.
 */
export function decryptCredentials(cipherJson: string): Record<string, unknown> {
  assertAes256GcmSupported();
  const key = getEncryptionKey();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cipherJson);
  } catch {
    // Not valid JSON at all — return empty
    return {};
  }
  // Check if this looks like an encrypted payload (has iv, data, tag string fields)
  if (typeof parsed.iv === "string" && typeof parsed.data === "string" && typeof parsed.tag === "string") {
    const { iv, data, tag } = parsed as { iv: string; data: string; tag: string };
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    let decrypted = decipher.update(data, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return JSON.parse(decrypted) as Record<string, unknown>;
  }
  // Legacy plaintext JSON — return as-is
  return parsed as Record<string, unknown>;
}
