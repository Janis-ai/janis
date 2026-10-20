CREATE TABLE "conv_tombstones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merged_into_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
