create table eval_suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  -- the scheduled batch that regressed — groups all suggestions from one
  -- triage pass and links the card to its run history
  batch_id uuid not null,
  -- which flip this fixes; null for suite-level notes (unrunnable, unclear)
  test_id uuid references agent_tests(id) on delete set null,
  kind text not null, -- knowledge_gap | prompt_drift | test_stale | hypothesis
  summary text not null,
  -- apply payload: {type:'knowledge',entry} | {type:'system_prompt',append}
  -- | {type:'expectation',test_id,expectation} | null (hypothesis-only)
  patch jsonb,
  -- null when unverified; else {pass_rate, baseline_rate, batch_id?}
  verified jsonb,
  status text not null default 'pending', -- pending | applied | dismissed
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index eval_suggestions_agent on eval_suggestions(agent_id, status);
