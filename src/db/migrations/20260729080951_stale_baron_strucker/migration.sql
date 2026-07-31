LOCK TABLE "room", "room_seat" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
	duplicate_users text;
BEGIN
	SELECT string_agg(duplicate.user_id, ', ' ORDER BY duplicate.user_id)
	INTO duplicate_users
	FROM (
		SELECT room_seat.user_id
		FROM room_seat
		JOIN room ON room.id = room_seat.room_id
		WHERE room_seat.user_id IS NOT NULL
			AND room.status IN ('lobby', 'playing', 'paused')
		GROUP BY room_seat.user_id
		HAVING count(DISTINCT room_seat.room_id) > 1
	) AS duplicate;

	IF duplicate_users IS NOT NULL THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Cannot enforce one active room per user: duplicate active room seats exist for user(s): ' || duplicate_users,
			HINT = 'Resolve the duplicate active seats without discarding games, then rerun the migration.';
	END IF;
END
$$;--> statement-breakpoint
CREATE TABLE "active_room_membership" (
	"user_id" text PRIMARY KEY,
	"room_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "active_room_membership_room_id_idx" ON "active_room_membership" ("room_id");--> statement-breakpoint
ALTER TABLE "active_room_membership" ADD CONSTRAINT "active_room_membership_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "active_room_membership" ADD CONSTRAINT "active_room_membership_room_id_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "active_room_membership" ("user_id", "room_id")
SELECT room_seat.user_id, room_seat.room_id
FROM room_seat
JOIN room ON room.id = room_seat.room_id
WHERE room_seat.user_id IS NOT NULL
	AND room.status IN ('lobby', 'playing', 'paused')
ORDER BY room_seat.user_id;--> statement-breakpoint
CREATE FUNCTION sync_active_room_membership_for_seat() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM 1 FROM room WHERE room.id = NEW.room_id FOR SHARE;
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM 1 FROM room WHERE room.id = OLD.room_id FOR SHARE;
	ELSE
		PERFORM 1 FROM room
		WHERE room.id IN (OLD.room_id, NEW.room_id)
		ORDER BY room.id
		FOR SHARE;
	END IF;

	IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.user_id IS NOT NULL THEN
		DELETE FROM active_room_membership
		WHERE user_id = OLD.user_id AND room_id = OLD.room_id;
	END IF;

	IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.user_id IS NOT NULL AND EXISTS (
		SELECT 1 FROM room
		WHERE room.id = NEW.room_id AND room.status IN ('lobby', 'playing', 'paused')
	) THEN
		INSERT INTO active_room_membership (user_id, room_id)
		VALUES (NEW.user_id, NEW.room_id);
	END IF;

	RETURN COALESCE(NEW, OLD);
END
$$;--> statement-breakpoint
CREATE TRIGGER sync_active_room_membership_on_seat
AFTER INSERT OR DELETE OR UPDATE OF user_id, room_id ON room_seat
FOR EACH ROW EXECUTE FUNCTION sync_active_room_membership_for_seat();--> statement-breakpoint
CREATE FUNCTION sync_active_room_membership_for_room_status() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.status IN ('lobby', 'playing', 'paused')
		AND NEW.status NOT IN ('lobby', 'playing', 'paused') THEN
		DELETE FROM active_room_membership WHERE room_id = NEW.id;
	ELSIF OLD.status NOT IN ('lobby', 'playing', 'paused')
		AND NEW.status IN ('lobby', 'playing', 'paused') THEN
		INSERT INTO active_room_membership (user_id, room_id)
		SELECT room_seat.user_id, NEW.id
		FROM room_seat
		WHERE room_seat.room_id = NEW.id AND room_seat.user_id IS NOT NULL
		ORDER BY room_seat.user_id;
	END IF;

	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER sync_active_room_membership_on_room_status
AFTER UPDATE OF status ON room
FOR EACH ROW EXECUTE FUNCTION sync_active_room_membership_for_room_status();
