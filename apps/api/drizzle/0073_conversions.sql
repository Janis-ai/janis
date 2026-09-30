ALTER TABLE "campaigns" ADD COLUMN "goal" text;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD COLUMN "converted_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "conversion_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid,
	"campaign_send_id" uuid,
	"campaign_id" uuid,
	"event" text NOT NULL,
	"value_cents" integer,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversion_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	CONSTRAINT "conversion_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null,
	CONSTRAINT "conversion_events_campaign_send_id_fk" FOREIGN KEY ("campaign_send_id") REFERENCES "public"."campaign_sends"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX "conversion_events_ws" ON "conversion_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "campaign_sends_contact" ON "campaign_sends" USING btree ("contact_id","created_at");
