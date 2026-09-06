ALTER TABLE `operators` ADD `failed_login_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `operators` ADD `locked_until` text;