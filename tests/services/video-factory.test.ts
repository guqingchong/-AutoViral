import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sep } from "node:path";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createTemplate } from "../../src/db/templates-repo.js";
import { createWork } from "../../src/db/works-repo.js";
import type { DbWork } from "../../src/db/types.js";
import { startRender, getRenderStatus } from "../../src/services/video-factory.js";

describe("video-factory", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("creates a render job from a template", async () => {
    createTemplate({
      id: "tpl_1",
      name: "Test",
      content_form: "knowledge",
      canvas: { width: 1080, height: 1920, fps: 30 },
      variables: [{ name: "title", type: "text", label: "标题", default: "默认" }],
      layers: [{ id: "t", type: "text", content: "{{title}}", start: 0, duration: 1, position: "center", fontSize: 48 }],
      audio: [],
      transitions: [],
      status: "approved",
    });

    const work: DbWork = {
      id: "w_1", title: "Test", type: "short-video", status: "draft",
      platforms: ["douyin"], evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    createWork(work, []);

    const job = await startRender({
      workId: "w_1",
      templateId: "tpl_1",
      digitalHumanVideo: "/tmp/host.mp4",
      voiceAudio: "/tmp/voice.wav",
      assets: { title: "Hello" },
    });

    expect(job.jobId).toMatch(/^job_/);
    expect(job.outputPath).toContain(`w_1${sep}output${sep}`);
    const status = getRenderStatus(job.jobId);
    expect(status?.status).toMatch(/pending|running|failed/);
  });
});
