import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    pexels: { apiKey: "fake-pexels" },
    pixabay: { apiKey: "fake-pixabay" },
    unsplash: { accessKey: "fake-unsplash" },
  }),
}));

vi.mock("../../src/services/asset-library.js", () => ({
  uploadAsset: vi.fn().mockResolvedValue({ id: 1, name: "test" }),
}));

const { getConfiguredStockProviders, downloadStockAsset, searchStockAssets } = await import("../../src/services/stock-asset-service.js");

describe("stock-asset-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns configured providers in priority order (Pexels first, no Openverse)", async () => {
    const providers = await getConfiguredStockProviders();
    expect(providers).toEqual(["pexels", "pixabay", "unsplash"]);
    expect(providers).not.toContain("openverse");
  });

  it("downloadStockAsset calls uploadAsset with correct metadata", async () => {
    const { uploadAsset } = await import("../../src/services/asset-library.js");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    );
    await downloadStockAsset({
      url: "https://images.pexels.com/photos/123/pexels-photo-123.jpeg",
      provider: "pexels",
      category: "scenes",
      name: "test.jpg",
      description: "test",
      author: "tester",
      license: "Pexels License",
    });
    expect(uploadAsset).toHaveBeenCalledTimes(1);
    const callArg = (uploadAsset as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.source).toBe("pexels");
    expect(callArg.license).toBe("commercial");
    expect(callArg.metadata.license).toBe("Pexels License");
    fetchMock.mockRestore();
  });

  it("downloadStockAsset handles video with mp4 name and mediaType metadata", async () => {
    const { uploadAsset } = await import("../../src/services/asset-library.js");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    );
    await downloadStockAsset({
      url: "https://videos.pexels.com/video-files/123/123-hd_1920_1080_25fps.mp4",
      provider: "pexels",
      mediaType: "video",
      category: "scenes",
      duration: 15,
    });
    const callArg = (uploadAsset as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.type).toBe("video");
    expect(callArg.name).toMatch(/\.mp4$/);
    expect(callArg.tags).toContain("video");
    expect(callArg.metadata.mediaType).toBe("video");
    expect(callArg.metadata.duration).toBe(15);
    fetchMock.mockRestore();
  });

  it("downloadStockAsset infers video from .mp4 URL when mediaType omitted", async () => {
    const { uploadAsset } = await import("../../src/services/asset-library.js");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    );
    await downloadStockAsset({
      url: "https://cdn.pixabay.com/video/2023/01/01/12345_large.mp4?dl=1",
      provider: "pixabay",
      category: "scenes",
    });
    const callArg = (uploadAsset as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.type).toBe("video");
    expect(callArg.name).toMatch(/\.mp4$/);
    fetchMock.mockRestore();
  });

  it("searchStockAssets with mediaType=video returns pexels videos with duration and best file", async () => {
    const pexelsVideoResponse = {
      videos: [
        {
          id: 456,
          width: 1920,
          height: 1080,
          duration: 12,
          image: "https://images.pexels.com/videos/456/preview.jpg",
          user: { name: "alice" },
          video_files: [
            { id: 1, quality: "uhd", file_type: "video/mp4", width: 3840, height: 2160, link: "https://videos.pexels.com/456-4k.mp4" },
            { id: 2, quality: "hd", file_type: "video/mp4", width: 1920, height: 1080, link: "https://videos.pexels.com/456-hd.mp4" },
            { id: 3, quality: "sd", file_type: "video/webm", width: 640, height: 360, link: "https://videos.pexels.com/456.webm" },
          ],
        },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.pexels.com/videos/search")) return new Response(JSON.stringify(pexelsVideoResponse), { status: 200 });
      if (url.includes("pixabay.com/api/videos")) return new Response(JSON.stringify({ hits: [] }), { status: 200 });
      // 图片搜索不应被调用（mediaType=video）
      throw new Error(`unexpected fetch: ${url}`);
    });
    const results = await searchStockAssets("ocean waves", { mediaType: "video", providers: ["pexels", "pixabay"] });
    const pexels = results.find((r) => r.provider === "pexels");
    expect(pexels?.items).toHaveLength(1);
    const item = pexels!.items[0];
    expect(item.mediaType).toBe("video");
    expect(item.duration).toBe(12);
    // 选 ≤1920 宽度中最大的 mp4 文件，跳过 4K 和 webm
    expect(item.url).toBe("https://videos.pexels.com/456-hd.mp4");
    expect(item.width).toBe(1920);
    expect(item.previewUrl).toContain("preview.jpg");
    expect(item.author).toBe("alice");
    fetchMock.mockRestore();
  });

  it("searchStockAssets skips image-only providers when mediaType=video", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.pexels.com/videos/search")) return new Response(JSON.stringify({ videos: [] }), { status: 200 });
      if (url.includes("pixabay.com/api/videos")) return new Response(JSON.stringify({ hits: [] }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    // unsplash 仅图片，mediaType=video 时不应发起任何请求、也不报错
    const results = await searchStockAssets("city", { mediaType: "video" });
    expect(results.find((r) => r.provider === "unsplash")).toBeUndefined();
    fetchMock.mockRestore();
  });

  it("searchStockAssets results are sorted with Pexels first regardless of completion order", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.pexels.com/videos/search")) return new Response(JSON.stringify({ videos: [] }), { status: 200 });
      if (url.includes("api.pexels.com/v1/search")) return new Response(JSON.stringify({ photos: [{ id: 1, src: { large2x: "https://images.pexels.com/1.jpg", medium: "https://images.pexels.com/1m.jpg" } }] }), { status: 200 });
      if (url.includes("pixabay.com/api/videos")) return new Response(JSON.stringify({ hits: [] }), { status: 200 });
      if (url.includes("pixabay.com/api/")) return new Response(JSON.stringify({ hits: [{ id: 2, largeImageURL: "https://cdn.pixabay.com/2.jpg", previewURL: "https://cdn.pixabay.com/2p.jpg" }] }), { status: 200 });
      if (url.includes("api.unsplash.com")) return new Response(JSON.stringify({ results: [{ id: "3", urls: { full: "https://images.unsplash.com/3.jpg", small: "https://images.unsplash.com/3s.jpg" } }] }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const results = await searchStockAssets("city", { mediaType: "image" });
    expect(results.map((r) => r.provider)).toEqual(["pexels", "pixabay", "unsplash"]);
    fetchMock.mockRestore();
  });

  it("searchStockAssets pixabay video prefers medium variant", async () => {
    const pixabayVideoResponse = {
      hits: [
        {
          id: 789,
          duration: 20,
          user: "bob",
          tags: "city, night",
          picture_id: "abc123",
          videos: {
            large: { url: "https://cdn.pixabay.com/789_large.mp4", width: 3840, height: 2160 },
            medium: { url: "https://cdn.pixabay.com/789_medium.mp4", width: 1280, height: 720 },
            small: { url: "https://cdn.pixabay.com/789_small.mp4", width: 960, height: 540 },
          },
        },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("pixabay.com/api/videos")) return new Response(JSON.stringify(pixabayVideoResponse), { status: 200 });
      if (url.includes("api.pexels.com/videos/search")) return new Response(JSON.stringify({ videos: [] }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const results = await searchStockAssets("city night", { mediaType: "video", providers: ["pixabay", "pexels"] });
    const pixabay = results.find((r) => r.provider === "pixabay");
    expect(pixabay?.items).toHaveLength(1);
    const item = pixabay!.items[0];
    expect(item.url).toBe("https://cdn.pixabay.com/789_medium.mp4");
    expect(item.previewUrl).toBe("https://i.vimeocdn.com/video/abc123_640x360.jpg");
    expect(item.duration).toBe(20);
    fetchMock.mockRestore();
  });
});