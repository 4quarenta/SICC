CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operator_email` text NOT NULL,
	`action` text NOT NULL,
	`target_id` integer,
	`query` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created_at_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text NOT NULL,
	`cpf` text NOT NULL,
	`birth_date` text,
	`mother_name` text,
	`city` text,
	`state` text,
	`status` text DEFAULT 'review' NOT NULL,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_cpf_unique` ON `people` (`cpf`);--> statement-breakpoint
CREATE INDEX `people_full_name_idx` ON `people` (`full_name`);