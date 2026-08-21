import type { Publisher, PublishInput, PublishOutput } from "./types.js";
import { ChannelsWebPublisher } from "./channels-web-publisher.js";

/**
 * 视频号发布器:Playwright 网页自动化(视频号助手)。
 * 2026-08-19:影刀 RPA 兜底分支删除——影刀从未跑通、无人配置(2026-08-05 已定论),
 * 死代码清理经用户确认。保留 ChannelsPublisher 类名以兼容 factory/publishing 装配点。
 */
export class ChannelsPublisher implements Publisher {
  readonly platform = "channels";
  readonly name = "微信视频号";

  constructor(private web: Publisher = new ChannelsWebPublisher()) {}

  async isConfigured(accountId?: string): Promise<boolean> {
    return this.web.isConfigured(accountId);
  }

  publish(input: PublishInput): Promise<PublishOutput> {
    return this.web.publish(input);
  }

  async login(accountId?: string): Promise<boolean> {
    if ("login" in this.web && typeof (this.web as ChannelsWebPublisher).login === "function") {
      return (this.web as ChannelsWebPublisher).login(accountId);
    }
    return false;
  }
}
