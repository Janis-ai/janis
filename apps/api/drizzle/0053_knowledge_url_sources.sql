ALTER TABLE "knowledge_files" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "knowledge_files" ADD COLUMN "refresh_hours" integer;--> statement-breakpoint
ALTER TABLE "knowledge_files" ADD COLUMN "last_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_files" ADD COLUMN "next_fetch_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "knowledge_files_due" ON "knowledge_files" USING btree ("next_fetch_at");