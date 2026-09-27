CREATE TABLE "slack_pending_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"bot_token" text NOT NULL,
	"installer_slack_user_id" text,
	"installer_user_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
