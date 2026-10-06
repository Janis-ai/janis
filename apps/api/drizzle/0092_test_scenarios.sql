alter table agent_tests add column category text not null default 'general';
--> statement-breakpoint
alter table agent_tests add column source text not null default 'transcript';
--> statement-breakpoint
alter table agent_tests add column human_result text;
--> statement-breakpoint
alter table agent_tests add column human_run_at timestamp with time zone;
--> statement-breakpoint
alter table agent_tests add column config_version text;
