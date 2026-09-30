-- Auto-drafted expectations on rescued-conversation tests: written by the
-- LLM at save time, cleared when an operator edits — the "AI draft" badge.
alter table "agent_tests" add column "expectation_draft" boolean DEFAULT false NOT NULL;
