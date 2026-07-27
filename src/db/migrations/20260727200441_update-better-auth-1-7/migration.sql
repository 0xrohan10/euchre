ALTER TABLE "account" RENAME COLUMN "account_id" TO "provider_account_id";--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "account" WHERE "provider_id" <> 'credential') THEN
    RAISE EXCEPTION 'Cannot infer Better Auth 1.7 issuer for a non-credential account';
  END IF;
END $$;--> statement-breakpoint
UPDATE "account" SET "issuer" = 'local:credential';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_providerAccountId_uidx" ON "account" ("issuer","provider_account_id");
