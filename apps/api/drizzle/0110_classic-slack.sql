CREATE TABLE "slack_classic_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"source_channel" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"name" text NOT NULL,
	"client_key" text,
	"source_user" text,
	"team" text,
	"source_team" text,
	"lang" text,
	"is_wordhop_channel" boolean DEFAULT true NOT NULL,
	"is_training_channel" boolean DEFAULT false NOT NULL,
	"training_enabled" boolean DEFAULT false NOT NULL,
	"last_message_ts" text,
	"last_agent_ts" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"should_process_transcript" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_classic_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"slack_user_id" text NOT NULL,
	"dm_channel_id" text,
	"client_key" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "mode" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "classic_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_classic_channels" ADD CONSTRAINT "slack_classic_channels_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_classic_prefs" ADD CONSTRAINT "slack_classic_prefs_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_classic_channels_src" ON "slack_classic_channels" USING btree ("installation_id","source_channel");--> statement-breakpoint
CREATE INDEX "slack_classic_channels_slack" ON "slack_classic_channels" USING btree ("slack_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_classic_prefs_member_bot" ON "slack_classic_prefs" USING btree ("installation_id","slack_user_id","client_key");