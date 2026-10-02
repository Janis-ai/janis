create table agent_widgets (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  -- slug the model emits: "WIDGET_REF: plans" → this row's spec. Lowercase
  -- because the model will lowercase whatever we show it.
  name text not null,
  spec jsonb not null,
  -- pinned to the chat opener: the webchat bootstrap renders it under the
  -- greeting on an empty thread
  auto_greet boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create unique index agent_widgets_agent_name on agent_widgets(agent_id, name);
