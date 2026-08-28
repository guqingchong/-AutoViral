import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { saveSharedAsset, deleteSharedAsset, validateCategory, getSharedAssetPath } from "../shared-assets.js";
import * as assetsRepo from "../db/assets-repo.js";
import type { DbAsset, DbAssetCategory, DbAssetType, DbAssetSource, DbAssetLicense } from "../db/types.js";

function detectType(filename: string): DbAssetType {
  const ext = extname(filename).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm", ".avi"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".flac"].includes(ext)) return "audio";
  if ([".ttf", ".otf", ".woff", ".woff2"].includes(ext)) return "font";
  return "other";
}

function sanitizeName(name: string): string {
  const base = name.replace(/[\\/:*?\"<>|]/g, "_").trim();
  return base || `asset_${Date.now()}`;
}

export function checkCompliance(asset: Pick<DbAsset, "source" | "license" | "metadata">): DbAsset["compliance_status"] {
  if (asset.source === "self-generated") return "passed";
  if (["pexels", "pixabay", "unsplash"].includes(asset.source) && ["cc0", "commercial"].includes(asset.license)) return "passed";
  if (asset.source === "upload" && asset.license === "commercial") return "passed";
  if (asset.source === "upload" && asset.license === "needs-review") return "pending";
  return "pending";
}

export async function uploadAsset(input: {
  name: string;
  data: Buffer;
  category: DbAssetCategory;
  type?: DbAssetType;
  source?: DbAssetSource;
  license?: DbAssetLicense;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): Promise<DbAsset> {
  validateCategory(input.category);
  const type = input.type ?? detectType(input.name);
  const source = input.source ?? "upload";
  const license = input.license ?? (source === "upload" ? "needs-review" : "unknown");
  const safeName = sanitizeName(input.name);
  const saved = await saveSharedAsset(input.category, safeName, input.data);
  const asset = assetsRepo.createAsset({
    name: saved.name,
    file_path: `${input.category}/${saved.name}`,
    category: input.category,
    type,
    tags: input.tags ?? [],
    source,
    license,
    compliance_status: "pending",
    metadata: input.metadata ?? {},
    usage_count: 0,
  });
  const status = checkCompliance(asset);
  return assetsRepo.updateAsset(asset.id, { compliance_status: status }) ?? asset;
}

function validateExternalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP/HTTPS URLs are allowed");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("Localhost URLs are not allowed");
  }
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname)) {
    throw new Error("Private IP addresses are not allowed");
  }
}

export async function importAssetFromUrl(input: {
  url: string;
  category: DbAssetCategory;
  name?: string;
  type?: DbAssetType;
  source?: DbAssetSource;
  license?: DbAssetLicense;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): Promise<DbAsset> {
  validateCategory(input.category);
  validateExternalUrl(input.url);
  const res = await fetch(input.url, { signal: AbortSignal.timeout(120_000) }); // 批次10.3
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const name = input.name ?? `download_${Date.now()}.bin`;
  return uploadAsset({ ...input, name, data });
}

export function listAssets(filters?: Parameters<typeof assetsRepo.listAssets>[0]) {
  const rows = assetsRepo.listAssets(filters);
  return rows.map((a) => ({ ...a, url: `/api/shared-assets/${encodeURIComponent(a.category)}/${encodeURIComponent(a.name)}` }));
}

export async function updateAsset(id: number, updates: Partial<Omit<DbAsset, "id" | "created_at" | "updated_at">>): Promise<DbAsset | undefined> {
  const existing = assetsRepo.getAsset(id);
  if (!existing) return undefined;
  const newCategory = updates.category ?? existing.category;
  const newName = updates.name ? sanitizeName(updates.name) : existing.name;
  if (newCategory !== existing.category || newName !== existing.name) {
    validateCategory(newCategory as DbAssetCategory);
    const data = await readFile(getSharedAssetPath(existing.category, existing.name));
    const saved = await saveSharedAsset(newCategory as DbAssetCategory, newName, data);
    await deleteSharedAsset(existing.category, existing.name);
    updates.name = saved.name;
    updates.category = saved.category as DbAssetCategory;
    updates.file_path = `${saved.category}/${saved.name}`;
  }
  const updated = assetsRepo.updateAsset(id, updates);
  if (!updated) return undefined;
  const status = checkCompliance(updated);
  return assetsRepo.updateAsset(id, { compliance_status: status }) ?? updated;
}

export async function deleteAsset(id: number): Promise<boolean> {
  const asset = assetsRepo.getAsset(id);
  if (!asset) return false;
  try { await deleteSharedAsset(asset.category, asset.name); } catch { /* file may already be gone */ }
  return assetsRepo.deleteAsset(id);
}

export async function recheckCompliance(id: number): Promise<DbAsset | undefined> {
  const asset = assetsRepo.getAsset(id);
  if (!asset) return undefined;
  const status = checkCompliance(asset);
  return assetsRepo.updateAsset(id, { compliance_status: status });
}
