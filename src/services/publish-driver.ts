export interface PublishInput {
  title: string;
  content: string;
  mediaPath?: string;
  coverPath?: string;
  tags?: string[];
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
