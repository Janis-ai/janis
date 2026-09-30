create table hook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  event text not null,
  target_url text not null,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index hook_subscriptions_agent_event on hook_subscriptions (agent_id, event);
