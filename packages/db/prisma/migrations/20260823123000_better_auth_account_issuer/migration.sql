ALTER TABLE "accounts" ADD COLUMN "issuer" VARCHAR(255) NOT NULL;

DROP INDEX "accounts_provider_id_account_id_key";
CREATE UNIQUE INDEX "accounts_issuer_account_id_key" ON "accounts"("issuer", "account_id");
