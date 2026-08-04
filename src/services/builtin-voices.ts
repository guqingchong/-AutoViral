import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { listSystemVoices } from "../providers/minimax-voice-clone.js";

export const BUILTIN_CATEGORIES = ["男声", "女声", "童声", "方言", "多语种", "场景", "其他"] as const;

export interface BuiltinVoice {
  voice_id: string;
  name: string;
  category: string;
  description?: string;
}

interface VoiceMeta { name: string; category: string; description?: string }

// tsc 不拷贝 .json 到 dist：先尝试 dist/data（若构建产物中有拷贝），再回退到 cwd 下的 src/data
const META_PATH_CANDIDATES = [
  join(dirname(fileURLToPath(import.meta.url)), "..", "data", "builtin-voices.json"),
  join(process.cwd(), "src", "data", "builtin-voices.json"),
];
const META_PATH = META_PATH_CANDIDATES.find((p) => existsSync(p)) ?? META_PATH_CANDIDATES[0];

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { at: number; voices: BuiltinVoice[] } | null = null;

async function loadMeta(): Promise<Record<string, VoiceMeta>> {
  return JSON.parse(await readFile(META_PATH, "utf-8")) as Record<string, VoiceMeta>;
}

export async function listBuiltinVoices(): Promise<BuiltinVoice[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.voices;
  const meta = await loadMeta();
  let voices: BuiltinVoice[];
  try {
    const config = await loadConfig();
    if (!config.minimax?.apiKey) throw new Error("no apiKey");
    const remote = await listSystemVoices({ apiKey: config.minimax.apiKey, groupId: (config.minimax as any).groupId });
    if (!remote.length) throw new Error("empty list");
    voices = remote.map((v) => {
      const m = meta[v.voice_id];
      return m
        ? { voice_id: v.voice_id, name: m.name, category: m.category, description: m.description }
        : { voice_id: v.voice_id, name: v.name || v.voice_id, category: "其他", description: v.description };
    });
  } catch {
    // 回退：静态精选（已验证音色子集）
    voices = Object.entries(meta).map(([voice_id, m]) => ({ voice_id, ...m }));
  }
  cache = { at: Date.now(), voices };
  return voices;
}
