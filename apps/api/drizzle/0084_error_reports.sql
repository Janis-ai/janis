create table error_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  source text not null default 'web',
  message text not null,
  stack text,
  url text,
  -- the agent-readable bundle: dom snapshot, screenshot data-url, console
  -- tail, recent failed requests, client settings, route, user agent
  payload jsonb,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index error_reports_ws_time on error_reports(workspace_id, created_at);
