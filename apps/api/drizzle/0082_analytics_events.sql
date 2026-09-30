create table analytics_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  event text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index analytics_events_ws_time on analytics_events (workspace_id, created_at);
