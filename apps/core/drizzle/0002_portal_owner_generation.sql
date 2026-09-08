CREATE TABLE "auth_state" (
	"id" text PRIMARY KEY NOT NULL,
	"portal_owner_generation" integer DEFAULT 0 NOT NULL
);
