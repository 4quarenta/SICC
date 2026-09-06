CREATE TABLE `operator_invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` integer NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`used_by` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_invites_code_hash_unique` ON `operator_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `operator_invites_creator_idx` ON `operator_invites` (`created_by`);--> statement-breakpoint
CREATE TABLE `operator_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`operator_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_sessions_token_hash_unique` ON `operator_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `operator_sessions_operator_idx` ON `operator_sessions` (`operator_id`);--> statement-breakpoint
CREATE TABLE `operators` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name_rank` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`role` text DEFAULT 'operator' NOT NULL,
	`invited_by` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operators_email_unique` ON `operators` (`email`);--> statement-breakpoint
CREATE INDEX `operators_invited_by_idx` ON `operators` (`invited_by`);