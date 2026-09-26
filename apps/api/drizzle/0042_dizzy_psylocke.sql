CREATE TABLE "agent_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text,
	"display_name" text,
	"avatar_url" text,
	"show_identity" boolean,
	"notify_prefs" jsonb,
	"invited_by" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_replies" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "llm_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_members" ADD CONSTRAINT "agent_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_members" ADD CONSTRAINT "agent_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_members" ADD CONSTRAINT "agent_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_members_agent_user" ON "agent_members" USING btree ("agent_id","user_id");--> statement-breakpoint
ALTER TABLE "saved_replies" ADD CONSTRAINT "saved_replies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;