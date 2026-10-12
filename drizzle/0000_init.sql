CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`email` text,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`scopes` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_external_idx` ON `accounts` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer,
	`workflow_id` integer,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_video_idx` ON `events` (`video_id`);--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`dedupe_key` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`run_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`locked_by` text,
	`locked_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_at_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `jobs_dedupe_idx` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `quota_usage` (
	`date_pt` text PRIMARY KEY NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`uploads` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_id` integer NOT NULL,
	`drive_id` text NOT NULL,
	`item_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text,
	`e_tag` text,
	`source_created_at` integer,
	`source_modified_at` integer,
	`duration_ms` integer,
	`last_seen_size` integer NOT NULL,
	`stable_since` integer NOT NULL,
	`status` text DEFAULT 'discovered' NOT NULL,
	`sequence` integer,
	`title` text,
	`description` text,
	`tags` text,
	`privacy_status` text,
	`publish_at` integer,
	`title_source` text,
	`youtube_video_id` text,
	`upload_session_url` text,
	`bytes_downloaded` integer DEFAULT 0 NOT NULL,
	`bytes_uploaded` integer DEFAULT 0 NOT NULL,
	`error` text,
	`uploaded_at` integer,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `videos_workflow_item_idx` ON `videos` (`workflow_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `videos_status_idx` ON `videos` (`status`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`onedrive_account_id` integer NOT NULL,
	`drive_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`folder_path` text NOT NULL,
	`recursive` integer DEFAULT false NOT NULL,
	`include_existing` integer DEFAULT false NOT NULL,
	`youtube_account_id` integer NOT NULL,
	`mode` text DEFAULT 'review' NOT NULL,
	`title_template` text DEFAULT '{filename}' NOT NULL,
	`description_template` text DEFAULT '' NOT NULL,
	`tags_template` text DEFAULT '' NOT NULL,
	`use_ai` integer DEFAULT false NOT NULL,
	`ai_context` text DEFAULT '' NOT NULL,
	`privacy_status` text DEFAULT 'private' NOT NULL,
	`category_id` text DEFAULT '22' NOT NULL,
	`playlist_id` text,
	`playlist_title` text,
	`made_for_kids` integer DEFAULT false NOT NULL,
	`post_upload_action` text DEFAULT 'none' NOT NULL,
	`post_upload_folder_id` text,
	`post_upload_folder_path` text,
	`poll_interval_min` integer DEFAULT 15 NOT NULL,
	`stable_minutes` integer DEFAULT 5 NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`last_scanned_at` integer,
	`last_scan_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`onedrive_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`youtube_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
