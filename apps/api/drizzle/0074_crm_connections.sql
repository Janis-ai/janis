CREATE TABLE "crm_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text DEFAULT 'hubspot' NOT NULL,
	"credentials_enc" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"list_id" uuid,
	"watermark" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"synced_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	CONSTRAINT "crm_connections_list_id_contact_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."contact_lists"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX "crm_connections_ws" ON "crm_connections" USING btree ("workspace_id");
