ALTER TABLE "campaign_sends" ADD COLUMN "step_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD COLUMN "replied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "steps" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_recipient" ON "campaign_sends" USING btree ("campaign_id","step_index","recipient");
