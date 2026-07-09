import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createAsset, getAsset, listAssets, updateAsset, deleteAsset } from "../../src/db/assets-repo.js";

function makeAsset(overrides: Partial<import("../../src/db/types.js").DbAsset> = {}): Omit<import("../../src/db/types.js").DbAsset, "id" | "created_at" | "updated_at"> {
  return {
    name: "bgm.mp3",
    file_path: "music/bgm.mp3",
    category: "music",
    type: "audio",
    tags: ["happy"],
    source: "upload",
    license: "needs-review",
    compliance_status: "pending",
    metadata: { duration: 120 },
    usage_count: 0,
    ...overrides,
  };
}

describe("assets-repo", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("creates and filters assets", () => {
    createAsset(makeAsset({ name: "a.mp3", category: "music", type: "audio", tags: ["calm"] }));
    createAsset(makeAsset({ name: "b.png", file_path: "scenes/b.png", category: "scenes", type: "image", tags: ["city"] }));
    expect(listAssets({ category: "music" }).length).toBe(1);
    expect(listAssets({ tag: "city" })[0].name).toBe("b.png");
  });

  it("updates and deletes asset", () => {
    const a = createAsset(makeAsset());
    updateAsset(a.id, { license: "cc0", compliance_status: "passed" });
    expect(getAsset(a.id)?.compliance_status).toBe("passed");
    expect(deleteAsset(a.id)).toBe(true);
    expect(getAsset(a.id)).toBeUndefined();
  });
});
