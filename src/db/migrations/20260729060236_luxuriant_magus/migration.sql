CREATE TABLE "room_creation" (
	"user_id" text,
	"operation_id" uuid,
	"operation_kind" varchar(24) NOT NULL,
	"room_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_creation_pkey" PRIMARY KEY("user_id","operation_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "room_creation_room_id_idx" ON "room_creation" ("room_id");--> statement-breakpoint
ALTER TABLE "room_creation" ADD CONSTRAINT "room_creation_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
