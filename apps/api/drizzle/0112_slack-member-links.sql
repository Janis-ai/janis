CREATE TABLE "slack_member_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_member_links" ADD CONSTRAINT "slack_member_links_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_member_links" ADD CONSTRAINT "slack_member_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_member_links_install_slack" ON "slack_member_links" USING btree ("installation_id","slack_user_id");--> statement-breakpoint
CREATE INDEX "slack_member_links_install_user" ON "slack_member_links" USING btree ("installation_id","user_id");