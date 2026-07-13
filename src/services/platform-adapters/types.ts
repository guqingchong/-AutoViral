/**
 * Analytics source configuration for a platform.
 * Stored in config.analytics.sources and used to drive collection.
 */
export interface AnalyticsSource {
  platform: string;
  authType: "api" | "cookie" | "rpa";
  accountUrl?: string;
  credentials: Record<string, string>;
}

/**
 * Collected metrics from a platform for a specific post or account.
 */
export interface CollectedMetrics {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  collects?: number;
  completionRate?: number;
  followers?: number;
  collectedAt: string;
  rawData: Record<string, unknown>;
}

/**
 * A single comment from a platform.
 */
export interface CollectedComment {
  externalCommentId?: string;
  authorName?: string;
  authorId?: string;
  content: string;
  isReply: boolean;
  parentExternalId?: string;
  collectedAt: string;
}

/**
 * Result published back to a platform (reply to a comment).
 */
export interface ReplyResult {
  success: boolean;
  replyId?: string;
  error?: string;
}

/**
 * Each platform (Kuaishou, Bilibili, Douyin, etc.) implements this interface.
 * Official-API adapters return data directly; scraping adapters use Playwright.
 */
export interface PlatformAdapter {
  /** Unique key matching DbPublishRecord.platform */
  readonly platform: string;
  /** Human-readable label for the UI */
  readonly label: string;

  /**
   * Collect account-level metrics (followers, total likes, etc.).
   * Called periodically by the analytics scheduler.
   */
  collectAccountMetrics(): Promise<CollectedMetrics>;

  /**
   * Collect post-level metrics for a published work.
   * @param externalId - The platform-specific post/page ID.
   */
  collectPostMetrics(externalId: string): Promise<CollectedMetrics>;

  /**
   * Collect comments for a published post.
   * @param externalId - The platform-specific post/page ID.
   * @param cursor - Pagination cursor (platform-specific).
   */
  collectComments(
    externalId: string,
    cursor?: string
  ): Promise<{ comments: CollectedComment[]; nextCursor?: string }>;

  /**
   * Publish a reply to a comment.
   * @param externalCommentId - The comment to reply to.
   * @param text - Reply text content.
   */
  publishReply(externalCommentId: string, text: string): Promise<ReplyResult>;
}
