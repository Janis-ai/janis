ALTER TABLE "agents" ALTER COLUMN "auto_resume_minutes" SET DEFAULT 10;
--> statement-breakpoint
UPDATE "agents" SET "auto_resume_minutes" = 10 WHERE "auto_resume_minutes" IS NULL;
