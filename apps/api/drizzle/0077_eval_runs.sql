CREATE TABLE "agent_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	"test_name" text DEFAULT '' NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"passed" boolean,
	"reason" text DEFAULT '' NOT NULL,
	"reply" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_test_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	CONSTRAINT "agent_test_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "agent_test_runs_agent_batch" ON "agent_test_runs" USING btree ("agent_id","batch_id");--> statement-breakpoint
CREATE INDEX "agent_test_runs_test" ON "agent_test_runs" USING btree ("test_id","created_at");
