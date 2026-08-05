import { Publisher, type PublishInput, type PublishOutput } from "./types.js";
import { ZhihuOfficialPublisher } from "./zhihu-official-publisher.js";
import { ZhihuWebPublisher } from "./zhihu-web-publisher.js";

/**
 * 知乎发布器：官方 API 优先（若持有有效 OAuth token），否则走网页自动化。
 * 知乎开放平台已关闭个人申请，绝大多数情况实际生效的是 ZhihuWebPublisher。
 */
export class ZhihuPublisher implements Publisher {
  readonly platform = "zhihu";
  readonly name = "知乎";

  constructor(
    private official: Publisher = new ZhihuOfficialPublisher(),
    private web: Publisher = new ZhihuWebPublisher()
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
    if ("login" in this.web && typeof (this.web as ZhihuWebPublisher).login === "function") {
      return (this.web as ZhihuWebPublisher).login();
    }
    return false;
  }
}
