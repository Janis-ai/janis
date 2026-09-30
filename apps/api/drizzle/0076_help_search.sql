ALTER TABLE "help_articles" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "help_articles" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("body", ''))) STORED;--> statement-breakpoint
CREATE INDEX "help_articles_search" ON "help_articles" USING gin ("search_vector");--> statement-breakpoint
CREATE TABLE "help_search_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"query" text NOT NULL,
	"results" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_search_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	CONSTRAINT "help_search_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "help_search_log_agent" ON "help_search_log" USING btree ("agent_id","created_at");
