import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/services/h3-instance-service.js", () => ({
  checkH3Health: vi.fn(),
  recordH3Activity: vi.fn(),
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
import { downloadFile } from "../../src/providers/_volcengine-cv.js";
import { LocalH3Provider } from "../../src/providers/local-h3.js";

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

describe("local-h3 provider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
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
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ prompt_id: "p1" }))          // POST /prompt
      .mockResolvedValueOnce(jsonResponse(completedHistory("p1")));      // GET /history/p1

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
    const submitCall = fetchMock.mock.calls[0];
    expect(submitCall[0]).toBe(`${BASE}/prompt`);
    const graph = JSON.parse(submitCall[1].body).prompt;
    expect(graph["104"].class_type).toBe("MiniMaxH3ImageToVideo");
    expect(graph["104"].inputs.prompt).toBe("航拍推进,产业园区全景");
    expect(graph["104"].inputs.width).toBe(480);
    expect(graph["104"].inputs.height).toBe(864);
    expect(graph["104"].inputs.length).toBe(124); // 5s → 17k+5 网格
    expect(graph["104"].inputs.first_frame).toBeUndefined();
    expect(graph["6"].inputs.unet_name).toContain("minimax_h3");

    // 下载 URL 指向 ComfyUI /view
    expect(downloadFile).toHaveBeenCalledWith(
      `${BASE}/view?filename=out.mp4&subfolder=h3&type=output`,
      expect.stringContaining("clip-01.mp4"),
    );
    expect(h3Service.recordH3Activity).toHaveBeenCalled();
  });

  it("i2v 路径:firstFrame URL → 上传 ComfyUI → LoadImage 接入 104 节点", async () => {
    const fetchMock = global.fetch as any;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, true))                     // GET firstFrame 图片字节
      .mockResolvedValueOnce(jsonResponse({ name: "frame-01.png" }))     // POST /upload/image
      .mockResolvedValueOnce(jsonResponse({ prompt_id: "p2" }))          // POST /prompt
      .mockResolvedValueOnce(jsonResponse(completedHistory("p2")));      // GET /history/p2

    const result = await provider.generateVideo({
      prompt: "镜头缓慢推近",
      firstFrame: "http://localhost:3271/api/works/w1/assets/frames/frame-01.png",
      workId: "w1",
      filename: "clips/clip-02.mp4",
    });

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/upload/image`);
    const graph = JSON.parse(fetchMock.mock.calls[2][1].body).prompt;
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
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ prompt_id: "p3" }))
      .mockResolvedValueOnce(jsonResponse(errorHistory("p3")))
      .mockResolvedValueOnce(jsonResponse({ prompt_id: "p4" }))
      .mockResolvedValueOnce(jsonResponse(errorHistory("p4")));

    const result = await provider.generateVideo({
      prompt: "x", workId: "w1", filename: "clips/c.mp4",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("API_ERROR");
    expect(result.error).toContain("OOM");
    // 2 次提交 + 2 次 history
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("下载失败重试 2 次后 → DOWNLOAD_FAILED", async () => {
    const fetchMock = global.fetch as any;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ prompt_id: "p5" }))
      .mockResolvedValueOnce(jsonResponse(completedHistory("p5")))
      .mockResolvedValueOnce(jsonResponse({ prompt_id: "p6" }))
      .mockResolvedValueOnce(jsonResponse(completedHistory("p6")));
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
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ prompt_id: "p7" }))
      .mockResolvedValueOnce(jsonResponse(completedHistory("p7")));

    await provider.generateVideo({
      prompt: "x", workId: "w1", filename: "clips/c.mp4", ratio: "16:9",
    });
    const graph = JSON.parse(fetchMock.mock.calls[0][1].body).prompt;
    expect(graph["104"].inputs.width).toBe(864);
    expect(graph["104"].inputs.height).toBe(480);
  });

  it("shotType=broll → prompt 追加无对白/仅环境音约定", async () => {
    const fetchMock = global.fetch as any;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ prompt_id: "p8" }))
      .mockResolvedValueOnce(jsonResponse(completedHistory("p8")));

    await provider.generateVideo({
      prompt: "雨夜街道空镜", workId: "w1", filename: "clips/c.mp4", shotType: "broll",
    });
    const graph = JSON.parse(fetchMock.mock.calls[0][1].body).prompt;
    expect(graph["104"].inputs.prompt).toContain("雨夜街道空镜");
    expect(graph["104"].inputs.prompt).toContain("无对白");
    expect(graph["104"].inputs.prompt).toContain("环境音");
  });

  it("shotType=dialogue → prompt 原样保留(台词由调用方写入)", async () => {
    const fetchMock = global.fetch as any;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ prompt_id: "p9" }))
      .mockResolvedValueOnce(jsonResponse(completedHistory("p9")));

    const p = "演播室,主持人开口说:「城投转型正在加速」";
    await provider.generateVideo({
      prompt: p, workId: "w1", filename: "clips/c.mp4", shotType: "dialogue",
    });
    const graph = JSON.parse(fetchMock.mock.calls[0][1].body).prompt;
    expect(graph["104"].inputs.prompt).toBe(p);
  });

  it("generateImage 明确拒绝", async () => {
    const result = await provider.generateImage({ prompt: "x", workId: "w1", filename: "a.png" });
    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_PARAMS");
  });
});
