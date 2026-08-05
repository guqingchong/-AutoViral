import { Publisher, type PublishInput, type PublishOutput } from "./types.js";
import { YingdaoRPAPublisher } from "./yingdao-publisher.js";
import { ChannelsWebPublisher } from "./channels-web-publisher.js";

/** 影刀机器人发布路径（保留为可选兜底，需配置 yingdao_bot_path） */
class ChannelsYingdaoPublisher extends YingdaoRPAPublisher {
  readonly platform = "channels";
  readonly name = "微信视频号";
  readonly botFileName = "channels_publish.bot";

  protected override buildBotArgs(input: PublishInput): string[] {
    return [
      "--video", input.videoPath,
      "--title", input.title,
      "--description", (input.options?.description as string) ?? "",
      "--tags", (input.options?.tags as string[] ?? []).join(","),
      "--cover", input.coverPath ?? "",
    ];
  }
}

/**
 * 视频号发布器：默认走 Playwright 网页自动化（视频号助手），
 * 若配置了影刀机器人路径（yingdao_bot_path）则优先使用影刀。
 */
export class ChannelsPublisher implements Publisher {
  readonly platform = "channels";
  readonly name = "微信视频号";

  constructor(
    private web: Publisher = new ChannelsWebPublisher(),
    private yingdao: Publisher = new ChannelsYingdaoPublisher()
  ) {}

  async isConfigured(): Promise<boolean> {
    return this.yingdao.isConfigured() || (await this.web.isConfigured());
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    if (this.yingdao.isConfigured()) {
      const result = await this.yingdao.publish(input);
      if (result.success) return result;
      const webResult = await this.web.publish(input);
      return { ...webResult, error: webResult.error ?? result.error };
    }
    return this.web.publish(input);
  }

  async login(): Promise<boolean> {
    if ("login" in this.web && typeof (this.web as ChannelsWebPublisher).login === "function") {
      return (this.web as ChannelsWebPublisher).login();
    }
    return false;
  }
}
