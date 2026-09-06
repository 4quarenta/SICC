CREATE TABLE `addresses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`person_id` integer NOT NULL,
	`label` text DEFAULT 'Residencial' NOT NULL,
	`address` text NOT NULL,
	`city` text,
	`state` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `addresses_person_idx` ON `addresses` (`person_id`);--> statement-breakpoint
CREATE TABLE `approaches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`person_id` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`latitude` text NOT NULL,
	`longitude` text NOT NULL,
	`accuracy_meters` integer,
	`location_label` text,
	`notes` text,
	`operator_email` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `approaches_person_idx` ON `approaches` (`person_id`);--> statement-breakpoint
CREATE INDEX `approaches_date_idx` ON `approaches` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `person_media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`person_id` integer NOT NULL,
	`kind` text NOT NULL,
	`object_key` text NOT NULL,
	`original_name` text NOT NULL,
	`content_type` text NOT NULL,
	`sha256` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_media_object_key_unique` ON `person_media` (`object_key`);--> statement-breakpoint
CREATE INDEX `person_media_person_idx` ON `person_media` (`person_id`);--> statement-breakpoint
CREATE INDEX `person_media_hash_idx` ON `person_media` (`sha256`);--> statement-breakpoint
CREATE TABLE `seized_objects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`person_id` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`seized_at` text,
	`location` text,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `seized_objects_person_idx` ON `seized_objects` (`person_id`);--> statement-breakpoint
ALTER TABLE `people` ADD `nickname` text;