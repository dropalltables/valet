ALTER TABLE "projects" ADD COLUMN "snapshot_key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "snapshot_base_branch" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "snapshot_volume" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "snapshot_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "snapshot_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "snapshot_last_used_at" timestamp with time zone;