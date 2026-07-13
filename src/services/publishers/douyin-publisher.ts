import { Publisher, type PublishInput, type PublishOutput } from "./types.js";
import { DouyinOfficialPublisher } from "./douyin-official-publisher.js";
import { DouyinWebPublisher } from "./douyin-web-publisher.js";

export class DouyinPublisher implements Publisher {
  readonly platform = "douyin";
  readonly name = "抖音";

  constructor(
    private official: Publisher = new DouyinOfficialPublisher(),
    private web: Publisher = new DouyinWebPublisher()
  ) {}

  async isConfigured(): Promise<boolean> {
    return this.official.isConfigured() || (await this.web.isConfigured());
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    if (this.official.isConfigured()) {
      const result = await this.official.publish(input);
      if (result.success) return result;
      const webResult = await this.web.publish(input);
      return { ...webResult, error: webResult.error ?? result.error };
    }
    return this.web.publish(input);
  }

  async login(): Promise<boolean> {
    if ("login" in this.web && typeof (this.web as DouyinWebPublisher).login === "function") {
      return (this.web as DouyinWebPublisher).login();
    }
    return false;
  }
}
