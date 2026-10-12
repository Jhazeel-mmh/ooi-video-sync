ALTER TABLE `videos` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `videos_content_hash_idx` ON `videos` (`content_hash`);--> statement-breakpoint
ALTER TABLE `workflows` ADD `until_date` integer;--> statement-breakpoint
ALTER TABLE `workflows` ADD `min_size_bytes` integer;--> statement-breakpoint
ALTER TABLE `workflows` ADD `max_size_bytes` integer;--> statement-breakpoint
ALTER TABLE `workflows` ADD `min_duration_sec` integer;--> statement-breakpoint
ALTER TABLE `workflows` ADD `max_duration_sec` integer;--> statement-breakpoint
ALTER TABLE `workflows` ADD `name_include` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `name_exclude` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `skip_duplicates` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- The date filter is now one of several filters.
UPDATE `videos` SET `ignored_reason` = 'filtered' WHERE `ignored_reason` = 'before_since';
