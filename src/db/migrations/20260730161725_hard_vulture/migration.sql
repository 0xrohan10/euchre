CREATE TABLE "room_scheduler_lease" (
	"room_id" uuid PRIMARY KEY,
	"mode" varchar(16) NOT NULL,
	"owner_id" uuid NOT NULL,
	"epoch" bigint DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_wakeup" (
	"room_id" uuid PRIMARY KEY,
	"generation" bigint DEFAULT 1 NOT NULL,
	"deadline_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_generation" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "room_wakeup_pending_idx" ON "room_wakeup" ("dispatched_generation","deadline_at");--> statement-breakpoint
ALTER TABLE "room_scheduler_lease" ADD CONSTRAINT "room_scheduler_lease_room_id_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_wakeup" ADD CONSTRAINT "room_wakeup_room_id_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE FUNCTION enqueue_room_wakeup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO "room_scheduler_lease" ("room_id", "mode", "owner_id", "expires_at")
		VALUES (NEW."id", 'legacy', '00000000-0000-4000-8000-000000000001', now())
		ON CONFLICT ("room_id") DO NOTHING;
	END IF;
	INSERT INTO "room_wakeup" ("room_id", "generation", "deadline_at", "updated_at")
	VALUES (NEW."id", 1, now(), now())
	ON CONFLICT ("room_id") DO UPDATE SET
		"generation" = "room_wakeup"."generation" + 1,
		"deadline_at" = LEAST("room_wakeup"."deadline_at", EXCLUDED."deadline_at"),
		"updated_at" = now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER room_wakeup_after_mutation
AFTER INSERT OR UPDATE OF "status", "version", "game", "updated_at" ON "room"
FOR EACH ROW EXECUTE FUNCTION enqueue_room_wakeup();
