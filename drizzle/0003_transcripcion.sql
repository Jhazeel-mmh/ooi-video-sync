ALTER TABLE `videos` ADD `transcript` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD `use_transcript` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `add_chapters` integer DEFAULT false NOT NULL;