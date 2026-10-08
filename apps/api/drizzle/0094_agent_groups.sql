-- Agent-scoped member groups: NULL agent_id keeps the existing workspace-wide
-- semantics; a set agent_id scopes the roster to one agent's rules.
ALTER TABLE "member_groups" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "member_groups" ADD CONSTRAINT "member_groups_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_groups_agent_id_idx" ON "member_groups" USING btree ("agent_id");
