import { YingdaoRPAPublisher } from "./yingdao-publisher.js";
import type { PublishInput } from "./types.js";

export class ChannelsPublisher extends YingdaoRPAPublisher {
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
