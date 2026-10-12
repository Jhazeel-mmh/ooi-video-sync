import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer({ mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer({ mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

export const PROVIDERS = ["microsoft", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ACCOUNT_STATUSES = ["active", "needs_reauth"] as const;

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    provider: text({ enum: PROVIDERS }).notNull(),
    /** Microsoft: Graph user id. Google: YouTube channel id. */
    externalId: text().notNull(),
    email: text(),
    displayName: text().notNull(),
    avatarUrl: text(),
    /** Encrypted with `encrypt()`. */
    accessToken: text().notNull(),
    /** Encrypted with `encrypt()`. */
    refreshToken: text().notNull(),
    expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
    scopes: text().notNull(),
    status: text({ enum: ACCOUNT_STATUSES }).notNull().default("active"),
    lastError: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex("accounts_provider_external_idx").on(t.provider, t.externalId)],
);

export const WORKFLOW_MODES = ["auto", "review"] as const;
export const PRIVACY_STATUSES = ["private", "unlisted", "public"] as const;
export type PrivacyStatus = (typeof PRIVACY_STATUSES)[number];
export const POST_UPLOAD_ACTIONS = ["none", "move"] as const;

export const workflows = sqliteTable("workflows", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  enabled: integer({ mode: "boolean" }).notNull().default(true),
  onedriveAccountId: integer()
    .notNull()
    .references(() => accounts.id),
  driveId: text().notNull(),
  folderId: text().notNull(),
  folderPath: text().notNull(),
  recursive: integer({ mode: "boolean" }).notNull().default(false),
  /** When false (and no `sinceDate`), videos already in the folder on the first scan are marked `ignored`. */
  includeExisting: integer({ mode: "boolean" }).notNull().default(false),
  // Filters: all optional and cumulative (a video must pass every one that is set).
  /** Only videos recorded on or after this instant (start of day in the app time zone). */
  sinceDate: integer({ mode: "timestamp_ms" }),
  /** Exclusive upper bound: start of the day after the chosen "until" date. */
  untilDate: integer({ mode: "timestamp_ms" }),
  minSizeBytes: integer(),
  maxSizeBytes: integer(),
  minDurationSec: integer(),
  maxDurationSec: integer(),
  /** Comma-separated words; the file name must contain at least one. */
  nameInclude: text().notNull().default(""),
  /** Comma-separated words; the file name must contain none. */
  nameExclude: text().notNull().default(""),
  /** Skip files whose content was already uploaded or queued by any workflow. */
  skipDuplicates: integer({ mode: "boolean" }).notNull().default(true),
  youtubeAccountId: integer()
    .notNull()
    .references(() => accounts.id),
  mode: text({ enum: WORKFLOW_MODES }).notNull().default("review"),
  titleTemplate: text().notNull().default("{filename}"),
  descriptionTemplate: text().notNull().default(""),
  tagsTemplate: text().notNull().default(""),
  useAi: integer({ mode: "boolean" }).notNull().default(false),
  aiContext: text().notNull().default(""),
  /** Transcribe the audio (Gemini) and give it to the AI when naming. */
  useTranscript: integer({ mode: "boolean" }).notNull().default(false),
  /** Append YouTube chapters (from the transcript) to the description. */
  addChapters: integer({ mode: "boolean" }).notNull().default(false),
  privacyStatus: text({ enum: PRIVACY_STATUSES }).notNull().default("private"),
  categoryId: text().notNull().default("22"),
  playlistId: text(),
  playlistTitle: text(),
  madeForKids: integer({ mode: "boolean" }).notNull().default(false),
  postUploadAction: text({ enum: POST_UPLOAD_ACTIONS }).notNull().default("none"),
  postUploadFolderId: text(),
  postUploadFolderPath: text(),
  pollIntervalMin: integer().notNull().default(15),
  stableMinutes: integer().notNull().default(5),
  counter: integer().notNull().default(0),
  lastScannedAt: integer({ mode: "timestamp_ms" }),
  lastScanError: text(),
  ...timestamps,
});

export const VIDEO_STATUSES = [
  "discovered",
  "pending_review",
  "queued",
  "downloading",
  "uploading",
  "processing",
  "published",
  "failed",
  "ignored",
  "waiting_quota",
] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const TITLE_SOURCES = ["template", "ai", "manual"] as const;

/** Why a video is `ignored`; only the automatic reasons are re-evaluated when the workflow changes. */
export const IGNORE_REASONS = ["existing", "filtered", "duplicate", "missing", "manual"] as const;
export type IgnoreReason = (typeof IGNORE_REASONS)[number];

export const videos = sqliteTable(
  "videos",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    workflowId: integer()
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    driveId: text().notNull(),
    itemId: text().notNull(),
    name: text().notNull(),
    /** Folder path inside the drive, e.g. `/Videos/2026`. */
    path: text().notNull(),
    size: integer().notNull(),
    mimeType: text(),
    eTag: text(),
    /** OneDrive content hash (quickXorHash, or sha1 on personal drives) to spot duplicates. */
    contentHash: text(),
    sourceCreatedAt: integer({ mode: "timestamp_ms" }),
    sourceModifiedAt: integer({ mode: "timestamp_ms" }),
    durationMs: integer(),
    lastSeenSize: integer().notNull(),
    /** Last time the file changed; the file is considered stable `stableMinutes` after this. */
    stableSince: integer({ mode: "timestamp_ms" }).notNull(),
    status: text({ enum: VIDEO_STATUSES }).notNull().default("discovered"),
    ignoredReason: text({ enum: IGNORE_REASONS }),
    sequence: integer(),
    title: text(),
    description: text(),
    tags: text({ mode: "json" }).$type<string[]>(),
    /** Audio transcript with `[h:mm:ss]` marks. */
    transcript: text(),
    privacyStatus: text({ enum: PRIVACY_STATUSES }),
    publishAt: integer({ mode: "timestamp_ms" }),
    titleSource: text({ enum: TITLE_SOURCES }),
    youtubeVideoId: text(),
    uploadSessionUrl: text(),
    bytesDownloaded: integer().notNull().default(0),
    bytesUploaded: integer().notNull().default(0),
    error: text(),
    uploadedAt: integer({ mode: "timestamp_ms" }),
    publishedAt: integer({ mode: "timestamp_ms" }),
    /** When the "new videos to review" notice covering this video was sent. */
    reviewNotifiedAt: integer({ mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("videos_workflow_item_idx").on(t.workflowId, t.itemId),
    index("videos_status_idx").on(t.status),
    index("videos_content_hash_idx").on(t.contentHash),
  ],
);

export const JOB_TYPES = [
  "scan_workflow",
  "generate_metadata",
  "transcribe_video",
  "transfer_video",
  "check_processing",
  "sync_metadata",
] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    type: text({ enum: JOB_TYPES }).notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** At most one queued/running job per key. */
    dedupeKey: text(),
    status: text({ enum: JOB_STATUSES }).notNull().default("queued"),
    runAt: integer({ mode: "timestamp_ms" }).notNull(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    lockedBy: text(),
    lockedAt: integer({ mode: "timestamp_ms" }),
    lastError: text(),
    ...timestamps,
  },
  (t) => [index("jobs_status_run_at_idx").on(t.status, t.runAt), index("jobs_dedupe_idx").on(t.dedupeKey)],
);

export const EVENT_LEVELS = ["info", "warn", "error"] as const;

export const events = sqliteTable(
  "events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    videoId: integer().references(() => videos.id, { onDelete: "cascade" }),
    workflowId: integer().references(() => workflows.id, { onDelete: "cascade" }),
    level: text({ enum: EVENT_LEVELS }).notNull().default("info"),
    message: text().notNull(),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("events_video_idx").on(t.videoId), index("events_created_idx").on(t.createdAt)],
);

export const quotaUsage = sqliteTable("quota_usage", {
  /** Date in America/Los_Angeles (YouTube quota resets at midnight PT), `yyyy-MM-dd`. */
  datePt: text().primaryKey(),
  units: integer().notNull().default(0),
  uploads: integer().notNull().default(0),
});

export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text({ mode: "json" }).notNull(),
});

export type Account = typeof accounts.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type Video = typeof videos.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Event = typeof events.$inferSelect;
