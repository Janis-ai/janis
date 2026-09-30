ALTER TABLE "campaigns" ADD COLUMN "send_cap" integer;--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"address" text NOT NULL,
	"kind" text DEFAULT 'all' NOT NULL,
	"reason" text DEFAULT 'manual' NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_ws_addr" ON "suppressions" USING btree ("workspace_id","address","kind");--> statement-breakpoint
CREATE INDEX "campaign_sends_ws_recipient" ON "campaign_sends" USING btree ("workspace_id","recipient","status","sent_at");
