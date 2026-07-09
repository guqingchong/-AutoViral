import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { getSharedAssetPath } from "../../src/shared-assets.js";
import { uploadAsset, listAssets, updateAsset, deleteAsset, checkCompliance } from "../../src/services/asset-library.js";

describe("asset-library service", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("uploads and checks compliance", async () => {
    const asset = await uploadAsset({
      name: "happy.mp3",
      data: Buffer.from("fake audio"),
      category: "music",
      source: "pexels",
      license: "cc0",
      tags: ["bgm"],
    });
    expect(asset.compliance_status).toBe("passed");
    expect(listAssets({ category: "music" })[0].name).toBe(asset.name);

    // Verify file exists on disk before deletion
    const absPath = getSharedAssetPath(asset.category, asset.name);
    expect(existsSync(absPath)).toBe(true);

    const deleted = await deleteAsset(asset.id);
    expect(deleted).toBe(true);

    // Verify file is removed from disk after deletion
    expect(existsSync(absPath)).toBe(false);
  });

  it("flags upload without commercial license as pending", () => {
    expect(checkCompliance({ source: "upload", license: "needs-review", metadata: {} })).toBe("pending");
    expect(checkCompliance({ source: "upload", license: "commercial", metadata: {} })).toBe("passed");
  });
});
