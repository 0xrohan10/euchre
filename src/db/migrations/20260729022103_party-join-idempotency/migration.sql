CREATE TABLE "party_join" (
	"user_id" text,
	"invite_code" uuid,
	"party_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_join_pkey" PRIMARY KEY("user_id","invite_code")
);
--> statement-breakpoint
CREATE INDEX "party_join_party_id_idx" ON "party_join" ("party_id");--> statement-breakpoint
ALTER TABLE "party_join" ADD CONSTRAINT "party_join_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "party_join" ADD CONSTRAINT "party_join_party_id_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE CASCADE;