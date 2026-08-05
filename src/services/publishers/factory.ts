import type { Publisher } from "./types.js";
import { DouyinPublisher } from "./douyin-publisher.js";
import { XiaohongshuPublisher } from "./xiaohongshu-publisher.js";
import { ChannelsPublisher } from "./channels-publisher.js";
import { KuaishouOfficialPublisher } from "./kuaishou-official-publisher.js";
import { BilibiliOfficialPublisher } from "./bilibili-official-publisher.js";
import { ZhihuPublisher } from "./zhihu-publisher.js";
import { WechatOfficialPublisher } from "./wechat-official-publisher.js";

const registry = new Map<string, () => Publisher>();

export function registerPublisher(platform: string, factory: () => Publisher): void {
  registry.set(platform, factory);
}

export function getPublisher(platform: string): Publisher {
  const factory = registry.get(platform);
  if (!factory) {
    throw new Error(`No publisher registered for platform: ${platform}`);
  }
  return factory();
}

export function listPublishers(): string[] {
  return Array.from(registry.keys());
}

/**
 * Register every built-in publisher so that getPublisher() resolves all PRD
 * platforms: 快手 / B站 / 公众号 (official API) + 抖音 / 小红书 / 视频号 / 知乎
 * (Playwright / RPA；知乎保留官方 API 优先，但开放平台已关闭个人申请)。Safe to call multiple times (idempotent).
 */
export function registerAllPublishers(): void {
  registerPublisher("kuaishou", () => new KuaishouOfficialPublisher());
  registerPublisher("bilibili", () => new BilibiliOfficialPublisher());
  registerPublisher("zhihu", () => new ZhihuPublisher());
  registerPublisher("wechat", () => new WechatOfficialPublisher());
  registerPublisher("douyin", () => new DouyinPublisher());
  registerPublisher("xiaohongshu", () => new XiaohongshuPublisher());
  registerPublisher("channels", () => new ChannelsPublisher());
}