import { describe, it, expect } from "vitest";
import { routeCloneUrl, extractUrlFromInput } from "../../src/services/template-clone.js";

describe("routeCloneUrl 平台路由", () => {
  it("小红书链接 → 图文克隆", () => {
    expect(routeCloneUrl("https://www.xiaohongshu.com/explore/abc123")).toEqual({ platform: "xiaohongshu", kind: "image-text" });
    expect(routeCloneUrl("https://xhslink.com/a/xyz")).toEqual({ platform: "xiaohongshu", kind: "image-text" });
  });

  it("抖音链接 → 视频克隆", () => {
    expect(routeCloneUrl("https://www.douyin.com/video/7123456789")).toEqual({ platform: "douyin", kind: "video" });
    expect(routeCloneUrl("https://v.douyin.com/abc/")).toEqual({ platform: "douyin", kind: "video" });
  });

  it("抖音分享口令(标题+话题+链接+引导语)→ 提取出视频链接", () => {
    const shareText = "2.58 02/17 l@p.dA :4pm uFU:/ 大二学姐手搓AI 量化交易机器人# 幻方量化 # ai https://v.douyin.com/lZ5dexz5WgE/ 复制此链接，打开Dou音搜索，直接观看视频！";
    expect(routeCloneUrl(shareText)).toEqual({ platform: "douyin", kind: "video" });
  });

  it("本地视频文件 → local 渠道", () => {
    expect(routeCloneUrl("D:\\videos\\ref.mp4")).toEqual({ platform: "local", kind: "video" });
    expect(routeCloneUrl("/home/user/ref.mov")).toEqual({ platform: "local", kind: "video" });
  });

  it("视频号链接 → 可读引导错误", () => {
    expect(() => routeCloneUrl("https://weixin.qq.com/sph/ADo0jgIpzt")).toThrow("视频号");
  });

  it("不支持的平台 → 抛可读错误", () => {
    expect(() => routeCloneUrl("https://www.bilibili.com/video/BV123")).toThrow("暂不支持");
    expect(() => routeCloneUrl("not-a-url")).toThrow("暂不支持");
  });
});

describe("extractUrlFromInput", () => {
  it("纯链接原样返回", () => {
    expect(extractUrlFromInput("https://v.douyin.com/abc/")).toBe("https://v.douyin.com/abc/");
  });
  it("分享口令提取链接", () => {
    expect(extractUrlFromInput("标题文字 https://v.douyin.com/abc/ 复制此链接")).toBe("https://v.douyin.com/abc/");
  });
  it("链接后紧跟中文标点不带入", () => {
    expect(extractUrlFromInput("看看 https://xhslink.com/a/xyz，不错的")).toBe("https://xhslink.com/a/xyz");
  });
  it("本地路径原样返回", () => {
    expect(extractUrlFromInput("D:\\videos\\ref.mp4")).toBe("D:\\videos\\ref.mp4");
  });
});
