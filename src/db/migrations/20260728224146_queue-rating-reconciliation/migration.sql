ALTER TABLE "pending_rating" ADD COLUMN "hand_results" jsonb;--> statement-breakpoint
CREATE INDEX "pending_rating_created_at_idx" ON "pending_rating" ("created_at");
