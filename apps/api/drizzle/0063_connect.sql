ALTER TABLE "workspaces" ADD COLUMN "stripe_connect_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "connect_charges_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agency_pricing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "connect_customer_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "connect_subscription_id" text;--> statement-breakpoint
CREATE INDEX "workspaces_connect_subscription" ON "workspaces" USING btree ("connect_subscription_id");
