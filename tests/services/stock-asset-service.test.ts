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

const { getConfiguredStockProviders, downloadStockAsset } = await import("../../src/services/stock-asset-service.js");

describe("stock-asset-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always includes Openverse as a free keyless provider", async () => {
    const providers = await getConfiguredStockProviders();
    expect(providers).toContain("openverse");
    expect(providers).toEqual(["openverse", "pexels", "pixabay", "unsplash"]);
  });

  it("downloadStockAsset calls uploadAsset with correct metadata", async () => {
    const { uploadAsset } = await import("../../src/services/asset-library.js");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    );
    await downloadStockAsset({
      url: "https://example.com/img.jpg",
      provider: "openverse",
      category: "scenes",
      name: "test.jpg",
      description: "test",
      author: "tester",
      license: "CC BY 4.0",
    });
    expect(uploadAsset).toHaveBeenCalledTimes(1);
    const callArg = (uploadAsset as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.source).toBe("openverse");
    expect(callArg.license).toBe("cc0");
    expect(callArg.metadata.license).toBe("CC BY 4.0");
    fetchMock.mockRestore();
  });
});