ALTER TABLE "contacts" ADD COLUMN "alt_emails" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "alt_phones" text[] DEFAULT '{}'::text[] NOT NULL;
