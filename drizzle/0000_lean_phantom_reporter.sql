CREATE TABLE `challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`wallet` text NOT NULL,
	`purpose` text NOT NULL,
	`deal_id` text,
	`version` integer,
	`terms_hash` text,
	`message` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deal_approvals` (
	`deal_id` text NOT NULL,
	`version` integer NOT NULL,
	`wallet` text NOT NULL,
	`terms_hash` text NOT NULL,
	`signature` text NOT NULL,
	`approved_at` text NOT NULL,
	PRIMARY KEY(`deal_id`, `version`, `wallet`),
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_identity` text NOT NULL,
	`brand_wallet` text NOT NULL,
	`creator_wallet` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`terms_json` text NOT NULL,
	`terms_hash` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deals_brand_idx` ON `deals` (`brand_wallet`);--> statement-breakpoint
CREATE INDEX `deals_creator_idx` ON `deals` (`creator_wallet`);--> statement-breakpoint
CREATE TABLE `payment_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`deal_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`tx_signature` text,
	`event_index` integer,
	`output_index` integer,
	`disclosure_ciphertext` text,
	`reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_deal_id_unique` ON `payment_intents` (`deal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_identity_key_idx` ON `payment_intents` (`identity_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`deal_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`network` text NOT NULL,
	`tx_signature` text NOT NULL,
	`record_json` text NOT NULL,
	`verified_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_id`) REFERENCES `payment_intents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_deal_id_unique` ON `receipts` (`deal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_intent_id_unique` ON `receipts` (`intent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_network_signature_idx` ON `receipts` (`network`,`tx_signature`);--> statement-breakpoint
CREATE TABLE `wallet_links` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`wallet` text NOT NULL,
	`linked_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_links_wallet_unique` ON `wallet_links` (`wallet`);