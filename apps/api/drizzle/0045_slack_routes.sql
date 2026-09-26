ALTER TABLE "agents" ADD COLUMN "slack_routes" jsonb;
--> statement-breakpoint

-- Backfill: the old single-destination override becomes a one-entry route.
-- installation_id falls back to the workspace's default (earliest) install.
UPDATE "agents" a
SET "slack_routes" = jsonb_build_array(jsonb_build_object(
  'installation_id',
  coalesce(
    a.slack_installation_id::text,
    (
      SELECT i.id::text FROM "slack_installations" i
      WHERE i.workspace_id = a.workspace_id
      ORDER BY i.created_at
      LIMIT 1
    )
  ),
  'channel_id', a.slack_channel_id
))
WHERE a.slack_installation_id IS NOT NULL OR a.slack_channel_id IS NOT NULL;
