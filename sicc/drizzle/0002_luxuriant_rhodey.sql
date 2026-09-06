CREATE TABLE `factions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `factions_name_unique` ON `factions` (`name`);--> statement-breakpoint
ALTER TABLE `addresses` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `people` ADD `faction_id` integer;