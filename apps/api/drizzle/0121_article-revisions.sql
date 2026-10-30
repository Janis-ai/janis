CREATE TABLE "help_article_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text,
	"category" text NOT NULL DEFAULT 'General',
	"seo_title" text,
	"seo_description" text,
	"body" text NOT NULL DEFAULT '',
	"status" text NOT NULL DEFAULT 'draft',
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "help_article_revisions" ADD CONSTRAINT "help_article_revisions_article_id_help_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."help_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_article_revisions" ADD CONSTRAINT "help_article_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "help_article_revisions_article" ON "help_article_revisions" USING btree ("article_id", "created_at");
