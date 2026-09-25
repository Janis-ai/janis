ALTER TABLE "slack_threads" ADD COLUMN "last_reply_ts" text;--> statement-breakpoint
ALTER TABLE "slack_installations" DROP COLUMN "team_domain";