CREATE TABLE "shopify_shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop" text NOT NULL,
	"workspace_id" uuid,
	"agent_id" uuid,
	"access_token_enc" text,
	"scopes" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'unlinked' NOT NULL,
	"billing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_shops_shop_unique" UNIQUE("shop")
);
--> statement-breakpoint
ALTER TABLE "shopify_shops" ADD CONSTRAINT "shopify_shops_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_shops" ADD CONSTRAINT "shopify_shops_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;