CREATE TABLE "typing_state" (
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "typing_state_conversation_id_kind_pk" PRIMARY KEY("conversation_id","kind")
);
--> statement-breakpoint
ALTER TABLE "typing_state" ADD CONSTRAINT "typing_state_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
