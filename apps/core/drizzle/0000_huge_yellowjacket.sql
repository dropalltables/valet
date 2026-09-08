CREATE TABLE "credentials" (
	"kind" text PRIMARY KEY NOT NULL,
	"payload_enc" text NOT NULL,
	"label" text,
	"method" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"verification_url" text NOT NULL,
	"user_code" text NOT NULL,
	"error" text,
	"container_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_env_vars" (
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"value_enc" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "project_env_vars_project_id_name_pk" PRIMARY KEY("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"repo_url" text,
	"default_branch" text NOT NULL,
	"has_setup_script" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"permissions" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"container_id" text,
	"volume_name" text NOT NULL,
	"supervisor_token_enc" text NOT NULL,
	"agent_session_id" text,
	"pr" jsonb,
	"cost_usd" double precision,
	"diff_stats" jsonb,
	"first_prompt" text NOT NULL,
	"repo_ready" boolean DEFAULT false NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_env_vars" ADD CONSTRAINT "project_env_vars_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_events" ADD CONSTRAINT "thread_events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_events_thread_seq_idx" ON "thread_events" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "threads_project_idx" ON "threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "threads_status_idx" ON "threads" USING btree ("status");