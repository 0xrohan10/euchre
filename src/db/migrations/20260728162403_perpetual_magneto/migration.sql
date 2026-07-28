CREATE TABLE "game_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_room_id" uuid NOT NULL,
	"source_match_id" uuid NOT NULL,
	"score_0" integer NOT NULL,
	"score_1" integer NOT NULL,
	"hand_count" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"seats" jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_history_participant" (
	"game_history_id" uuid,
	"user_id" text,
	CONSTRAINT "game_history_participant_pkey" PRIMARY KEY("game_history_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "room" ADD COLUMN "match_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "game_history_source_match_id_idx" ON "game_history" ("source_match_id");--> statement-breakpoint
CREATE INDEX "game_history_completed_at_idx" ON "game_history" ("completed_at");--> statement-breakpoint
CREATE INDEX "game_history_participant_user_id_idx" ON "game_history_participant" ("user_id");--> statement-breakpoint
ALTER TABLE "game_history_participant" ADD CONSTRAINT "game_history_participant_game_history_id_game_history_id_fkey" FOREIGN KEY ("game_history_id") REFERENCES "game_history"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "game_history_participant" ADD CONSTRAINT "game_history_participant_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;