CREATE TABLE "mcp_server_projects" (
	"server_id" text NOT NULL,
	"project_id" text NOT NULL,
	CONSTRAINT "mcp_server_projects_server_id_project_id_pk" PRIMARY KEY("server_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb NOT NULL,
	"values_enc" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "mcp_server_projects" ADD CONSTRAINT "mcp_server_projects_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_projects" ADD CONSTRAINT "mcp_server_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;