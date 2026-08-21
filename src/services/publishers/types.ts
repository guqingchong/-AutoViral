/** Phase 4b Publisher interface — distinct from Phase 4a's PlatformDriver. */

export interface PublishInput {
  /** Work ID for tracking the publish record. */
  workId: string;
  /** Absolute path to the video file. */
  videoPath: string;
  /** Absolute path to the cover image (optional). */
  coverPath?: string;
  /** Video / post title. */
  title: string;
  /** 目标发布账号(accounts.id);缺省走平台默认账号/旧凭证兜底。 */
  accountId?: string;
  /** Platform-specific extra fields (description, tags, schedule, …). */
  options?: Record<string, unknown>;
}

export interface PublishOutput {
  /** Whether the publish succeeded. */
  success: boolean;
  /** Public URL of the published post (when success). */
  postUrl?: string;
  /** Platform-assigned post / item ID (when success). */
  platformPostId?: string;
  /** 2026-08-19 P2:平台审核中(提交成功但未过审)——记录落 reviewing 态,
   *  由对账任务确认后转正 published/拒绝落 failed,不再一律当"已发布" */
  reviewing?: boolean;
  /** Human-readable error message (when !success). */
  error?: string;
}

export interface Publisher {
  readonly platform: string;
  readonly name: string;

  /** Quick check whether credentials are configured (optionally per account). */
  isConfigured(accountId?: string): boolean | Promise<boolean>;

  /** Execute the publish flow. */
  publish(input: PublishInput): Promise<PublishOutput>;

  /** Open a browser window for interactive login (optional). */
  login?(): Promise<boolean>;
}
