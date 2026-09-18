import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/services/h3-instance-service.js", () => ({
  checkH3Health: vi.fn(),
  recordH3Activity: vi.fn(),
  markH3UsedForWork: vi.fn(),
}));
vi.mock("../../src/services/h3-tunnel-service.js", () => ({
  ensureH3Tunnel: vi.fn(),
}));
vi.mock("../../src/config.js", () => ({
  getConfig: vi.fn(),
  dataDir: "C:/fake-data",
}));
vi.mock("../../src/providers/_volcengine-cv.js", () => ({
  downloadFile: vi.fn(),
}));

import * as h3Service from "../../src/services/h3-instance-service.js";
import * as h3Tunnel from "../../src/services/h3-tunnel-service.js";
import { getConfig } from "../../src/config.js";
import { downloadFile } from "../../src/providers/_volcengine-cv.js";
import { LocalH3Provider, __resetSageProbeForTests } from "../../src/providers/local-h3.js";

const BASE = "http://localhost:8188";
const provider = new LocalH3Provider({ baseUrl: BASE, pollIntervalMs: 1, pollTimeoutMs: 1000 });

function jsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
  } as unknown as Response;
}

const completedHistory = (promptId: string) => ({
  [promptId]: {
    status: { status_str: "success", completed: true, messages: [] },
    outputs: {
      "92": { video: [{ filename: "out.mp4", subfolder: "h3", type: "output" }] },
    },
  },
});

// 2026-09-11 SageAttention 加速接入后,generateVideo 会先探测 /object_info/PatchSageAttentionKJ。
// fetch mock 从"顺序队列"改为"按 URL 路由",per-test 用变量控制各端点行为。
let sageAvailable = false;
let promptSeq: Array<(init?: unknown) => unknown> = [];
let historySeq: Array<() => unknown> = [];

function route(url: string, init?: unknown): Promise<Response> {
  if (url.includes("/object_info/")) {
    return Promise.resolve(jsonResponse({}, sageAvailable, sageAvailable ? 200 : 404));
  }
  if (url.includes("/upload/image")) return Promise.resolve(jsonResponse({ name: "frame-01.png" }));
  if (url.endsWith("/prompt")) {
    const h = promptSeq.shift() ?? (() => ({ prompt_id: "px" }));
    return Promise.resolve(jsonResponse(h(init)));
  }
  if (url.includes("/history/")) {
    const id = url.split("/history/")[1];
    const h = historySeq.shift() ?? (() => completedHistory(id));
    return Promise.resolve(jsonResponse(h()));
  }
  // firstFrame 图片下载等其余 URL:返回空字节
  return Promise.resolve(jsonResponse({}));
}

/** 过滤出某类端点的调用 */
function callsTo(fetchMock: ReturnType<typeof vi.fn>, marker: string) {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes(marker));
}

describe("local-h3 provider", () => {
  beforeEach(() => {
    __resetSageProbeForTests();
    sageAvailable = false;
    promptSeq = [];
    historySeq = [];
    (getConfig as any).mockReturnValue({ h3: {} });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(route));
    (h3Tunnel.ensureH3Tunnel as any).mockResolvedValue(true);
    (h3Service.checkH3Health as any).mockResolvedValue(true);
    (downloadFile as any).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("t2v 成功路径:提交 → 轮询 → 下载,模板参数正确", async () => {
    const fetchMock = global.fetch as any;
    promptSeq = [() => ({ prompt_id: "p1" })];

    const result = await provider.generateVideo({
      prompt: "航拍推进,产业园区全景",
      workId: "w1",
      filename: "clips/clip-01.mp4",
      duration: 5,
    });

    expect(result.success).toBe(true);
    expect(result.assetPath).toContain("clip-01.mp4");
    expect(result.previewUrl).toBe("/api/works/w1/assets/clips/clip-01.mp4");

    // 校验提交的工作流:104 节点无 first_frame(t2v),尺寸/帧数/模型正确
    const submitCall = callsTo(fetchMock, "/prompt")[0];
    const graph = JSON.parse(submitCall[1].body).prompt;
    expect(graph["104"].class_type).toBe("MiniMaxH3ImageToVideo");
    expect(graph["104"].inputs.prompt).toBe("航拍推进,产业园区全景");
    expect(graph["104"].inputs.width).toBe(480);
    expect(graph["104"].inputs.height).toBe(864);
    expect(graph["104"].inputs.length).toBe(124); // 5s → 17k+5 网格
    expect(graph["104"].inputs.first_frame).toBeUndefined();
    expect(graph["6"].inputs.unet_name).toContain("minimax_h3");
    // 默认实例无 KJNodes(404)→ 不注入 SageAttention 补丁节点
    expect(graph["6s"]).toBeUndefined();
    expect(graph["9"].inputs.model).toEqual(["6", 0]);

    // 下载 URL 指向 ComfyUI /view
    expect(downloadFile).toHaveBeenCalledWith(
      `${BASE}/view?filename=out.mp4&subfolder=h3&type=output`,
      expect.stringContaining("clip-01.mp4"),
    );
    expect(h3Service.recordH3Activity).toHaveBeenCalled();
  });

  it("SageAttention 可用(object_info 200)→ 注入补丁节点并重接 model 引用", async () => {
    sageAvailable = true;
    const fetchMock = global.fetch as any;
    promptSeq = [() => ({ prompt_id: "p1s" })];

    const result = await provider.generateVideo({ prompt: "x", workId: "w1", filename: "clips/s.mp4" });
    expect(result.success).toBe(true);
    const graph = JSON.parse(callsTo(fetchMock, "/prompt")[0][1].body).prompt;
    expect(graph["6s"].class_type).toBe("PatchSageAttentionKJ");
    expect(graph["6s"].inputs.model).toEqual(["6", 0]);
    expect(graph["9"].inputs.model).toEqual(["6s", 0]);
    expect(graph["16"].inputs.model).toEqual(["6s", 0]);
  });

  it("config.h3.sageAttention=false → 即使实例可用也不注入", async () => {
    sageAvailable = true;
    (getConfig as any).mockReturnValue({ h3: { sageAttention: false } });
    const fetchMock = global.fetch as any;
    promptSeq = [() => ({ prompt_id: "p1n" })];

    await provider.generateVideo({ prompt: "x", workId: "w1", filename: "clips/n.mp4" });
    const graph = JSON.parse(callsTo(fetchMock, "/prompt")[0][1].body).prompt;
    expect(graph["6s"]).toBeUndefined();
    expect(graph["9"].inputs.model).toEqual(["6", 0]);
  });

  it("i2v 路径:firstFrame URL → 上传 ComfyUI → LoadImage 接入 104 节点", async () => {
    const fetchMock = global.fetch as any;
    promptSeq = [() => ({ prompt_id: "p2" })];

    const result = await provider.generateVideo({
      prompt: "镜头缓慢推近",
      firstFrame: "http://localhost:3271/api/works/w1/assets/frames/frame-01.png",
      workId: "w1",
      filename: "clips/clip-02.mp4",
    });

    expect(result.success).toBe(true);
    expect(callsTo(fetchMock, "/upload/image")).toHaveLength(1);
    const graph = JSON.parse(callsTo(fetchMock, "/prompt")[0][1].body).prompt;
    expect(graph["200"].class_type).toBe("LoadImage");
    expect(graph["200"].inputs.image).toBe("frame-01.png");
    expect(graph["104"].inputs.first_frame).toEqual(["200", 0]);
  });

  it("实例离线:隧道失败 → INSTANCE_OFFLINE,文案提醒开机 AutoDL", async () => {
    (h3Tunnel.ensureH3Tunnel as any).mockResolvedValue(false);
    const result = await provider.generateVideo({
      prompt: "x", workId: "w1", filename: "clips/c.mp4",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("INSTANCE_OFFLINE");
    expect(result.error).toContain("AutoDL");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("健康探测失败 → INSTANCE_OFFLINE", async () => {
    (h3Service.checkH3Health as any).mockResolvedValue(false);
    const result = await provider.generateVideo({
      prompt: "x", workId: "w1", filename: "clips/c.mp4",
    });
    expect(result.code).toBe("INSTANCE_OFFLINE");
  });

  it("ComfyUI 执行错误 → 重试 1 次后 API_ERROR", async () => {
    const fetchMock = global.fetch as any;
    const errorHistory = (id: string) => ({
      [id]: {
        status: { status_str: "error", completed: false, messages: [["execution_error", { exception_message: "OOM" }]] },
        outputs: {},
      },
    });
    promptSeq = [() => ({ prompt_id: "p3" }), () => ({ prompt_id: "p4" })];
    historySeq = [() => errorHistory("p3"), () => errorHistory("p4")];

    const result = await provider.generateVideo({
      prompt: "x", workId: "w1", filename: "clips/c.mp4",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("API_ERROR");
    expect(result.error).toContain("OOM");
    // 2 次提交 + 2 次 history(probe 走 /object_info,不计入)
    expect(callsTo(fetchMock, "/prompt")).toHaveLength(2);
    expect(callsTo(fetchMock, "/history/")).toHaveLength(2);
  });

  it("下载失败重试 2 次后 → DOWNLOAD_FAILED", async () => {
    promptSeq = [() => ({ prompt_id: "p5" }), () => ({ prompt_id: "p6" })];
    (downloadFile as any).mockRejectedValue(new Error("Download failed: 500"));

    const result = await provider.generateVideo({
      prompt: "x", workId: "w1", filename: "clips/c.mp4",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("DOWNLOAD_FAILED");
    // 每次生成尝试内下载重试 3 次,共 2 次生成尝试
    expect(downloadFile).toHaveBeenCalledTimes(6);
  });

  it("16:9 画幅 → 864×480", async () => {
    const fetchMock = global.fetch as any;
    promptSeq = [() => ({ prompt_id: "p7" })];

    await provider.generateVideo({
      prompt: "x", workId: "w1", filename: "clips/c.mp4", ratio: "16:9",
    });
    const graph = JSON.parse(callsTo(fetchMock, "/prompt")[0][1].body).prompt;
    expect(graph["104"].inputs.width).toBe(864);
    expect(graph["104"].inputs.height).toBe(480);
  });

  it("shotType=broll → prompt 追加无对白/仅环境音约定", async () => {
    const fetchMock = global.fetch as any;
    promptSeq = [() => ({ prompt_id: "p8" })];

    await provider.generateVideo({
      prompt: "航拍城市天际线",
      workId: "w1",
      filename: "clips/c.mp4",
      shotType: "broll",
    });
    const graph = JSON.parse(callsTo(fetchMock, "/prompt")[0][1].body).prompt;
    expect(graph["104"].inputs.prompt).toContain("无对白");
    expect(graph["104"].inputs.prompt).toContain("环境音");
  });

  it("shotType=dialogue → prompt 原样保留(台词由调用方写入)", async () => {
    const fetchMock = global.fetch as any;
    promptSeq = [() => ({ prompt_id: "p9" })];

    const p = "演播室,主持人开口说:「城投转型正在加速」";
    await provider.generateVideo({
      prompt: p, workId: "w1", filename: "clips/c.mp4", shotType: "dialogue",
    });
    const graph = JSON.parse(callsTo(fetchMock, "/prompt")[0][1].body).prompt;
    expect(graph["104"].inputs.prompt).toBe(p);
  });

  it("generateImage 明确拒绝", async () => {
    const result = await provider.generateImage({ prompt: "x", workId: "w1", filename: "a.png" });
    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_PARAMS");
  });
});
