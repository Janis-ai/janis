ALTER TABLE "agents" ADD COLUMN "auto_resume_minutes" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "human_since" timestamp with time zone;