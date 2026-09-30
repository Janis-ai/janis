create table help_votes (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references help_articles(id) on delete cascade,
  helpful boolean not null,
  voter text not null,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create unique index help_votes_voter on help_votes (article_id, voter);
