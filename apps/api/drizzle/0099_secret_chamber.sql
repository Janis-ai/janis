ALTER TABLE "shopify_shops" ADD COLUMN "refresh_token_enc" text;--> statement-breakpoint
ALTER TABLE "shopify_shops" ADD COLUMN "token_expires_at" timestamp with time zone;