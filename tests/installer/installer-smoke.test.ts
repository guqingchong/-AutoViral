import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

describe("installer smoke", () => {
  it("electron main entry exists", () => {
    expect(existsSync(join(ROOT, "electron", "main.cjs"))).toBe(true);
    expect(existsSync(join(ROOT, "electron", "preload.cjs"))).toBe(true);
  });

  it("electron-builder config exists", () => {
    expect(existsSync(join(ROOT, "electron-builder.yml"))).toBe(true);
  });

  it("build scripts exist", () => {
    expect(existsSync(join(ROOT, "scripts", "build-installer.ps1"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts", "build-installer.sh"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts", "download-ffmpeg.ps1"))).toBe(true);
  });

  it("launcher scripts exist", () => {
    expect(existsSync(join(ROOT, "scripts", "AutoViral.cmd"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts", "AutoViral.ps1"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts", "start-portable.bat"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts", "start-portable.ps1"))).toBe(true);
  });

  it("docs exist", () => {
    expect(existsSync(join(ROOT, "docs", "setup-guide.md"))).toBe(true);
    expect(existsSync(join(ROOT, "docs", "troubleshooting.md"))).toBe(true);
    expect(existsSync(join(ROOT, "docs", "ops", "windows-installer.md"))).toBe(true);
    expect(existsSync(join(ROOT, "docs", "ops", "claude-code-model-setup.md"))).toBe(true);
  });
});
