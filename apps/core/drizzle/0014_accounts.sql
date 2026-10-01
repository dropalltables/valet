CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"name" text NOT NULL,
	"payload_enc" text NOT NULL,
	"label" text,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "account_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_agent_name_idx" ON "accounts" USING btree ("agent","name");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Each existing Claude and Codex credential becomes an account named <noun>-<noun>-<1..10>,
-- the same words core uses for accounts nobody named, and every thread of that agent runs under it.
WITH nouns AS (SELECT ARRAY['acorn', 'anchor', 'arrow', 'badger', 'basil', 'beacon', 'birch', 'canyon', 'cedar', 'comet', 'coral', 'crane', 'delta', 'ember', 'falcon', 'fern', 'glacier', 'harbor', 'heron', 'island', 'jasper', 'juniper', 'kestrel', 'lantern', 'lotus', 'maple', 'marble', 'meadow', 'nickel', 'oak', 'orbit', 'otter', 'pebble', 'pine', 'quartz', 'raven', 'reef', 'river', 'saffron', 'sparrow', 'summit', 'thistle', 'timber', 'tulip', 'valley', 'walnut', 'willow', 'zephyr'] AS w)
INSERT INTO "accounts" ("id", "agent", "name", "payload_enc", "label", "method", "created_at", "updated_at")
SELECT
  substr(md5(random()::text || "kind"), 1, 12),
  "kind",
  (SELECT w FROM nouns)[1 + floor(random() * 48)::int] || '-' || (SELECT w FROM nouns)[1 + floor(random() * 48)::int] || '-' || (1 + floor(random() * 10)::int),
  "payload_enc", "label", "method", "updated_at", "updated_at"
FROM "credentials"
WHERE "kind" IN ('claude', 'codex');--> statement-breakpoint
UPDATE "threads" t SET "account_id" = a."id" FROM "accounts" a WHERE a."agent" = t."agent";--> statement-breakpoint
DELETE FROM "credentials" WHERE "kind" IN ('claude', 'codex');
