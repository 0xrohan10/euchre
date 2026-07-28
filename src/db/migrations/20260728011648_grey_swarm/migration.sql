CREATE TABLE "party" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_user_id" text NOT NULL,
  "invite_code" uuid DEFAULT gen_random_uuid() NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_member" (
  "party_id" uuid,
  "user_id" text,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "party_member_pkey" PRIMARY KEY("party_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rematch_vote" (
  "room_id" uuid,
  "user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rematch_vote_pkey" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "room" ADD COLUMN "party_id" uuid;--> statement-breakpoint
CREATE INDEX "party_owner_user_id_idx" ON "party" ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_member_user_id_idx" ON "party_member" ("user_id");--> statement-breakpoint
CREATE INDEX "room_party_id_idx" ON "room" ("party_id");--> statement-breakpoint
ALTER TABLE "party" ADD CONSTRAINT "party_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "party_member" ADD CONSTRAINT "party_member_party_id_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "party_member" ADD CONSTRAINT "party_member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rematch_vote" ADD CONSTRAINT "rematch_vote_room_id_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rematch_vote" ADD CONSTRAINT "rematch_vote_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_party_id_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE SET NULL;
