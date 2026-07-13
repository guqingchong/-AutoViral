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
  /** Human-readable error message (when !success). */
  error?: string;
}

export interface Publisher {
  readonly platform: string;
  readonly name: string;

  /** Quick check whether credentials are configured. */
  isConfigured(): boolean | Promise<boolean>;

  /** Execute the publish flow. */
  publish(input: PublishInput): Promise<PublishOutput>;

  /** Open a browser window for interactive login (optional). */
  login?(): Promise<boolean>;
}
