ALTER TABLE "help_articles" ADD COLUMN "slug" text;
--> statement-breakpoint
ALTER TABLE "help_articles" ADD COLUMN "seo_title" text;
--> statement-breakpoint
ALTER TABLE "help_articles" ADD COLUMN "seo_description" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "help_articles_slug" ON "help_articles" USING btree ("agent_id","slug") WHERE "slug" IS NOT NULL;
