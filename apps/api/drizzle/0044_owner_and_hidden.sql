ALTER TABLE "agents" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: earliest accepted admin (else earliest accepted member) owns the
-- workspace; agents inherit their workspace's owner. NULLs are legal — an
-- admin can claim ownership when no owner is recorded.
UPDATE "workspaces" w SET "owner_user_id" = (
  SELECT m."user_id" FROM "memberships" m
  WHERE m."workspace_id" = w."id" AND m."accepted_at" IS NOT NULL
  ORDER BY (m."role" = 'admin') DESC, m."created_at" ASC LIMIT 1
);--> statement-breakpoint
UPDATE "agents" a SET "owner_user_id" = (
  SELECT w."owner_user_id" FROM "workspaces" w WHERE w."id" = a."workspace_id"
);