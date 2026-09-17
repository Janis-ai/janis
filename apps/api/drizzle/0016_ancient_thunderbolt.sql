ALTER TABLE "conversations" ADD COLUMN "agent_summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_up_to" timestamp with time zone;