-- A webhook URL is the credential for Slack, Discord and ntfy, so it is stored
-- encrypted from here on. SQL cannot encrypt the rows already there; they are
-- dropped and the operator adds the webhooks again in Settings.
DELETE FROM "webhooks";--> statement-breakpoint
ALTER TABLE "webhooks" RENAME COLUMN "url" TO "url_enc";
