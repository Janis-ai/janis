ALTER TABLE "conversations" ADD COLUMN "op_summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "op_summary_up_to" timestamp with time zone;