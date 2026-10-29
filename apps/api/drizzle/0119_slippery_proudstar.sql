ALTER TABLE "knowledge_files" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_files" ADD CONSTRAINT "knowledge_files_parent_id_knowledge_files_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."knowledge_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_files_parent" ON "knowledge_files" USING btree ("parent_id");