export interface PublishInput {
  title: string;
  content: string;
  mediaPath?: string;
  coverPath?: string;
  tags?: string[];
  /** 批次7.6:超时取消信号——超时护栏触发时 abort,driver 内 fetch/浏览器流程应尽量响应 */
  signal?: AbortSignal;
}

export interface PublishResult {
  postUrl: string;
  publishedAt: string;
}

export interface PlatformDriver {
  readonly platform: string;
  publish(input: PublishInput): Promise<PublishResult>;
}

export class PlatformNotSupportedError extends Error {
  constructor(platform: string) {
    super(`Unsupported platform: ${platform}`);
  }
}
