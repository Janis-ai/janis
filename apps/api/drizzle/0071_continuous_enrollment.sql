ALTER TABLE "campaigns" ADD COLUMN "enrollment" text DEFAULT 'once' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "enroll_token" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "external_ids" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_enroll_token" ON "campaigns" USING btree ("enroll_token");
