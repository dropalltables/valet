ALTER TABLE "projects" ADD COLUMN "auto_create_pr" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archive_on_merge" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_fix_ci" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "threads" t SET "pr" = t."pr" || jsonb_build_object('autoFixCi', p."auto_fix_ci", 'ciFixAttempts', 0, 'ciFixSha', NULL)
FROM "projects" p WHERE p."id" = t."project_id" AND t."pr" IS NOT NULL;
