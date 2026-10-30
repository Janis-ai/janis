CREATE TABLE "agent_instruction_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"system_prompt" text NOT NULL DEFAULT '',
	"greeting" text NOT NULL DEFAULT '',
	"quick_replies" jsonb NOT NULL DEFAULT '[]',
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_instruction_revisions" ADD CONSTRAINT "agent_instruction_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instruction_revisions" ADD CONSTRAINT "agent_instruction_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_instruction_revisions_agent" ON "agent_instruction_revisions" USING btree ("agent_id", "created_at");
