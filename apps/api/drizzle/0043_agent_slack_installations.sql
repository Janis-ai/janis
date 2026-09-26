ALTER TABLE "agents" ADD COLUMN "slack_installation_id" uuid;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "team_name" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_slack_installation_id_slack_installations_id_fk" FOREIGN KEY ("slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE set null ON UPDATE no action;