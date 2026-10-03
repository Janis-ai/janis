create table member_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  member_ids jsonb not null default '[]',
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index member_groups_workspace on member_groups(workspace_id);
