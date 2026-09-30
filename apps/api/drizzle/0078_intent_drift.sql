-- Intent drift: who set the label ('ai' classified, 'byo' trusted from the
-- BYO agent payload, 'manual' operator override) and when the drift re-check
-- last ran (throttles the window re-classification to once per 15 min).
alter table "conversations" add column "intent_source" text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
alter table "conversations" add column "intent_checked_at" timestamp with time zone;
