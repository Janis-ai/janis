ALTER TABLE "workspaces" ADD COLUMN "parent_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "parent_contact" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_parent_workspace_id_workspaces_id_fk" FOREIGN KEY ("parent_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;