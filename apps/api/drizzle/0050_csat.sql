ALTER TABLE "conversations" ADD COLUMN "csat_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "csat_score" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "csat_asked_at" timestamp with time zone;