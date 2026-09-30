ALTER TABLE "crm_connections" ADD COLUMN "activity_writeback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "crm_activity_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"summary" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_activity_queue_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	CONSTRAINT "crm_activity_queue_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_activity_queue_ref" ON "crm_activity_queue" USING btree ("contact_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "crm_activity_queue_pending" ON "crm_activity_queue" USING btree ("workspace_id","synced_at");
