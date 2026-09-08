ALTER TABLE "threads" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "share_generation" integer DEFAULT 0 NOT NULL;