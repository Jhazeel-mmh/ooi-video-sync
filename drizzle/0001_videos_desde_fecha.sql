ALTER TABLE `videos` ADD `ignored_reason` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD `since_date` integer;--> statement-breakpoint
-- Backfill: classify videos ignored before this column existed.
UPDATE `videos` SET `ignored_reason` = CASE
  WHEN `error` = 'Ya estaba en la carpeta al crear el workflow' THEN 'existing'
  WHEN `error` = 'Ya no está en la carpeta de OneDrive' THEN 'missing'
  ELSE 'manual'
END
WHERE `status` = 'ignored';
