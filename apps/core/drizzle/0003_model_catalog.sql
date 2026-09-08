CREATE TABLE "model_catalog" (
	"agent" text PRIMARY KEY NOT NULL,
	"models" jsonb NOT NULL,
	"source" text NOT NULL,
	"refreshed_at" timestamp with time zone,
	"error" text
);
