ALTER TABLE "room_seat" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;
