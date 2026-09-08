import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { getDb, closeDb } from "./connection.js";
import { getConfig, getConfigDir } from "../config.js";

export interface BackupPaths {
  db: string;
  config: string;
  skills: string;
  assets: string;
  works: string;
}

export async function getBackupPaths(): Promise<BackupPaths> {
  const dir = getConfigDir();
  return {
    db: join(dir, "autoviral.db"),
    config: join(dir, "config.yaml"),
    skills: join(dir, "skills"),
    assets: join(dir, "shared-assets"),
    works: join(dir, "works"),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function exportBackup(destinationZip: string): Promise<void> {
  const paths = await getBackupPaths();
  const db = getDb();

  // 在线热备份：better-sqlite3 使用 SQLite backup API，含 WAL 一致性，
  // 备份期间服务不中断，无需 closeDb()。
  const tmpDb = join(getConfigDir(), "backup-tmp.db");
  await db.backup(tmpDb);

  const zip = new AdmZip();

  if (await pathExists(tmpDb)) {
    zip.addLocalFile(tmpDb, "db/autoviral.db");
  }
  if (await pathExists(paths.config)) {
    zip.addLocalFile(paths.config, "config");
  }
  if (await pathExists(paths.skills)) {
    zip.addLocalFolder(paths.skills, "skills");
  }
  if (await pathExists(paths.assets)) {
    zip.addLocalFolder(paths.assets, "shared-assets");
  }
  // works 只打包 works 表有记录的目录（排除 test/批量残留等无记录目录）
  if (await pathExists(paths.works)) {
    const valid = new Set(
      db
        .prepare("SELECT id FROM works")
        .pluck()
        .all()
        .map((v) => String(v))
    );
    for (const d of await readdir(paths.works)) {
      if (valid.has(String(d))) {
        zip.addLocalFolder(join(paths.works, d), "works/" + d);
      }
    }
  }

  await mkdir(join(destinationZip, ".."), { recursive: true });
  zip.writeZip(destinationZip);

  await rm(tmpDb, { force: true });

  // 滚动清理：只保留最近 N 份 autoviral-backup-*.zip
  await cleanupOldBackups();
}

export interface RestoreOptions {
  overwrite?: boolean;
}

export async function importBackup(sourceZip: string, opts: RestoreOptions = {}): Promise<string[]> {
  const paths = await getBackupPaths();

  // 恢复前留存现网快照：若现网 db 存在，先导出一份 pre-restore-<ts>.zip
  if (await pathExists(paths.db)) {
    const preRestoreZip = join(getConfigDir(), "pre-restore-" + Date.now() + ".zip");
    await exportBackup(preRestoreZip);
  }

  // 关闭连接以便安全覆盖 autoviral.db（exportBackup 为热备份，不再断开；此处覆盖前仍需释放句柄）
  closeDb();

  const zip = new AdmZip(sourceZip);
  const restored: string[] = [];

  // 完整性预检：对 zip 每个非目录 entry 做存在性 + CRC 可解压校验，
  // 发现损坏即刻抛错中止，禁止 "rm -rf 后裸解包"。
  for (const e of zip.getEntries()) {
    if (!e.isDirectory) {
      const found = zip.getEntry(e.entryName);
      if (!found) {
        throw new Error(`备份损坏：zip 缺少条目 ${e.entryName}，已中止恢复`);
      }
      // 触发解压以校验 CRC；损坏时 AdmZip 会抛错
      try {
        zip.readFile(found.entryName);
      } catch (err) {
        throw new Error(`备份损坏：条目 ${e.entryName} CRC 校验失败，已中止恢复`);
      }
    }
  }

  await mkdir(getConfigDir(), { recursive: true });

  const dbEntry = zip.getEntry("db/autoviral.db");
  if (dbEntry) {
    const target = paths.db;
    if (opts.overwrite || !(await pathExists(target))) {
      zip.extractEntryTo(dbEntry, join(target, ".."), false, true);
      restored.push("db/autoviral.db");
    }
  }

  const configEntry = zip.getEntry("config/config.yaml");
  if (configEntry) {
    const target = paths.config;
    if (opts.overwrite || !(await pathExists(target))) {
      zip.extractEntryTo(configEntry, join(target, ".."), false, true);
      restored.push("config/config.yaml");
    }
  }

  // addLocalFolder does not create directory entries, so scan by prefix
  const entries = zip.getEntries();

  if (entries.some(e => e.entryName.startsWith("skills/"))) {
    await restoreFolder(zip, entries, "skills/", paths.skills, opts.overwrite);
    restored.push("skills/");
  }

  if (entries.some(e => e.entryName.startsWith("shared-assets/"))) {
    await restoreFolder(zip, entries, "shared-assets/", paths.assets, opts.overwrite);
    restored.push("shared-assets/");
  }

  if (entries.some(e => e.entryName.startsWith("works/"))) {
    await restoreFolder(zip, entries, "works/", paths.works, opts.overwrite);
    restored.push("works/");
  }

  getDb();
  return restored;
}

/**
 * 滚动清理旧备份：保留最近 N 份（N 从 config.backup.retainCount 读取，缺省 7），删除更早的。
 * X19 验收修复(2026-09-07):① retainCount 改走 Config 接口的 backup 段(不再 as unknown as
 * 强转);② pre-restore-*.zip 此前不匹配清理正则,永久累积——恢复前快照同样纳入滚动
 * (单独保留最近 N 份,与定时快照各自计数,互不占额度)。
 */
export async function cleanupOldBackups(): Promise<void> {
  const dir = getConfigDir();
  const retain = getConfig().backup?.retainCount ?? 7;

  for (const pattern of [/^autoviral-backup-.*\.zip$/, /^pre-restore-.*\.zip$/]) {
    const files = (await readdir(dir))
      .filter((f) => pattern.test(f))
      .map((f) => join(dir, f));
    const statted = await Promise.all(
      files.map(async (f) => ({ f, mtime: (await stat(f)).mtimeMs }))
    );
    statted.sort((a, b) => b.mtime - a.mtime);
    for (const { f } of statted.slice(retain)) {
      await rm(f, { force: true });
    }
  }
}

async function restoreFolder(
  zip: AdmZip,
  entries: AdmZip.IZipEntry[],
  entryPrefix: string,
  targetDir: string,
  overwrite?: boolean
): Promise<void> {
  if (overwrite && (await pathExists(targetDir))) {
    await rm(targetDir, { recursive: true, force: true });
  }
  await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    if (entry.entryName.startsWith(entryPrefix)) {
      zip.extractEntryTo(entry, targetDir, false, true);
    }
  }
}
