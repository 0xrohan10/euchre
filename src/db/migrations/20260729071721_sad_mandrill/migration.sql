DROP INDEX "room_creation_room_id_idx";--> statement-breakpoint
CREATE INDEX "room_creation_room_id_idx" ON "room_creation" ("room_id");