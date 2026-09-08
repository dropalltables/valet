CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"secret_enc" text,
	"events" jsonb NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "vapid_public_key" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "vapid_private_key_enc" text;