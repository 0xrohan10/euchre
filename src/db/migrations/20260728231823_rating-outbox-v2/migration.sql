CREATE TABLE "rating_outbox" (
	"game_history_id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" varchar(16) NOT NULL,
	"participants" jsonb NOT NULL,
	"forfeit_team" integer,
	"hand_results" jsonb,
	"failed_at" timestamp with time zone,
	"failure_code" varchar(64)
);
--> statement-breakpoint
CREATE INDEX "rating_outbox_created_at_idx" ON "rating_outbox" ("created_at");--> statement-breakpoint
ALTER TABLE "rating_outbox" ADD CONSTRAINT "rating_outbox_game_history_id_game_history_id_fkey" FOREIGN KEY ("game_history_id") REFERENCES "game_history"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE FUNCTION redirect_legacy_rating_claim() RETURNS trigger AS $$
DECLARE
	legacy_work pending_rating%ROWTYPE;
	history_seats jsonb;
BEGIN
	IF current_setting('euchre.rating_consumer_v2', true) = '1' THEN
		RETURN NEW;
	END IF;

	DELETE FROM "pending_rating"
	WHERE "game_history_id" = NEW."game_history_id"
	RETURNING * INTO legacy_work;

	IF NOT FOUND THEN
		IF EXISTS (
			SELECT 1 FROM "rating_outbox"
			WHERE "game_history_id" = NEW."game_history_id"
		) THEN
			RETURN NULL;
		END IF;

		RETURN NEW;
	END IF;

	SELECT "seats" INTO history_seats
	FROM "game_history"
	WHERE "id" = legacy_work."game_history_id";

	INSERT INTO "rating_outbox" (
		"game_history_id",
		"created_at",
		"mode",
		"participants",
		"forfeit_team",
		"hand_results"
	)
	VALUES (
		legacy_work."game_history_id",
		legacy_work."created_at",
		COALESCE(legacy_work."mode", 'assisted'),
		COALESCE(
			legacy_work."participants",
			jsonb_build_array(
				(SELECT seat->'userId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(history_seats) = 'array' THEN history_seats ELSE '[]'::jsonb END) seat WHERE seat->>'seat' = '0' LIMIT 1),
				(SELECT seat->'userId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(history_seats) = 'array' THEN history_seats ELSE '[]'::jsonb END) seat WHERE seat->>'seat' = '1' LIMIT 1),
				(SELECT seat->'userId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(history_seats) = 'array' THEN history_seats ELSE '[]'::jsonb END) seat WHERE seat->>'seat' = '2' LIMIT 1),
				(SELECT seat->'userId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(history_seats) = 'array' THEN history_seats ELSE '[]'::jsonb END) seat WHERE seat->>'seat' = '3' LIMIT 1)
			)
		),
		legacy_work."forfeit_team",
		legacy_work."hand_results"
	)
	ON CONFLICT DO NOTHING;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "rated_match_redirect_legacy_claim"
BEFORE INSERT ON "rated_match"
FOR EACH ROW EXECUTE FUNCTION redirect_legacy_rating_claim();
