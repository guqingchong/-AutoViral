import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { getDb, closeDb } from "./connection.js";
import { getConfigDir } from "../config.js";

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
  closeDb();

  const zip = new AdmZip();

  if (await pathExists(paths.db)) {
    zip.addLocalFile(paths.db, "db");
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
  if (await pathExists(paths.works)) {
    zip.addLocalFolder(paths.works, "works");
  }

  await mkdir(join(destinationZip, ".."), { recursive: true });
  zip.writeZip(destinationZip);

  // Re-open database connection for the running process
  getDb();
}

export interface RestoreOptions {
  overwrite?: boolean;
}

export async function importBackup(sourceZip: string, opts: RestoreOptions = {}): Promise<string[]> {
  const paths = await getBackupPaths();
  closeDb();

  const zip = new AdmZip(sourceZip);
  const restored: string[] = [];

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
