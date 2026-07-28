CREATE TABLE "pending_rating" (
  "game_history_id" uuid PRIMARY KEY,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "mode" varchar(16),
  "participants" jsonb,
  "forfeit_team" integer
);
--> statement-breakpoint
CREATE TABLE "player_rating" (
  "user_id" text,
  "mode" varchar(16),
  "rating" integer DEFAULT 1000 NOT NULL,
  "games_played" integer DEFAULT 0 NOT NULL,
  "wins" integer DEFAULT 0 NOT NULL,
  "losses" integer DEFAULT 0 NOT NULL,
  "hands_played" integer DEFAULT 0 NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "calls_won" integer DEFAULT 0 NOT NULL,
  "partner_calls" integer DEFAULT 0 NOT NULL,
  "partner_calls_won" integer DEFAULT 0 NOT NULL,
  "defenses" integer DEFAULT 0 NOT NULL,
  "defenses_won" integer DEFAULT 0 NOT NULL,
  "tricks_won" integer DEFAULT 0 NOT NULL,
  "expected_tricks_milli" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "player_rating_pkey" PRIMARY KEY("user_id","mode")
);
--> statement-breakpoint
CREATE TABLE "rated_match" (
  "game_history_id" uuid PRIMARY KEY,
  "rated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "player_rating_mode_rating_idx" ON "player_rating" ("mode","rating");--> statement-breakpoint
ALTER TABLE "pending_rating" ADD CONSTRAINT "pending_rating_game_history_id_game_history_id_fkey" FOREIGN KEY ("game_history_id") REFERENCES "game_history"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "player_rating" ADD CONSTRAINT "player_rating_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rated_match" ADD CONSTRAINT "rated_match_game_history_id_game_history_id_fkey" FOREIGN KEY ("game_history_id") REFERENCES "game_history"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "rated_match" ("game_history_id") SELECT "id" FROM "game_history" ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE FUNCTION enqueue_pending_rating() RETURNS trigger AS $$
DECLARE
  room_game jsonb;
BEGIN
  SELECT "game" INTO room_game FROM "room" WHERE "id" = NEW."source_room_id";
  INSERT INTO "pending_rating" ("game_history_id", "mode", "participants", "forfeit_team")
  VALUES (
    NEW."id",
    room_game->>'ratingMode',
    room_game->'ratingParticipants',
    NULLIF(room_game->>'ratingForfeitTeam', '')::integer
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "game_history_enqueue_pending_rating"
AFTER INSERT ON "game_history"
FOR EACH ROW EXECUTE FUNCTION enqueue_pending_rating();
