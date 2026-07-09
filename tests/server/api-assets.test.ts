import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { ensureSharedDirs } from "../../src/shared-assets.js";

describe("asset library API", () => {
  beforeEach(async () => {
    resetInMemoryDb();
    migrate();
    await ensureSharedDirs();
  });
  afterEach(() => closeDb());

  it("uploads, lists and deletes an asset", async () => {
    const form = new FormData();
    form.append("file", new File([Buffer.from("fake audio")], "bgm.mp3", { type: "audio/mpeg" }));
    form.append("category", "music");
    form.append("source", "pexels");
    form.append("license", "cc0");
    form.append("tags", "bgm,intro");

    const res1 = await apiRoutes.request("/api/assets", { method: "POST", body: form });
    expect(res1.status).toBe(201);
    const asset = await res1.json();
    expect(asset.compliance_status).toBe("passed");

    const res2 = await apiRoutes.request("/api/assets");
    expect(res2.status).toBe(200);
    const { assets } = await res2.json();
    expect(assets.length).toBe(1);

    const res3 = await apiRoutes.request(`/api/assets/${asset.id}`, { method: "DELETE" });
    expect(res3.status).toBe(200);
  });
});
