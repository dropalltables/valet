-- What the UI calls services were "portals" in the schema; the processes Valet
-- supervises become "managed services".
ALTER TABLE "threads" RENAME COLUMN "services" TO "managed_services";--> statement-breakpoint
ALTER TABLE "threads" RENAME COLUMN "portals" TO "services";--> statement-breakpoint
ALTER TABLE "threads" RENAME COLUMN "portal_shares" TO "service_shares";--> statement-breakpoint
ALTER TABLE "auth_state" RENAME COLUMN "portal_owner_generation" TO "service_owner_generation";
