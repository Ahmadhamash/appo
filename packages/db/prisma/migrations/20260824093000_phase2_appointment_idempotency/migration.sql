CREATE TABLE "appointment_idempotencies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "request_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "appointment_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_idempotencies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_idempotencies_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "appointment_idempotencies_organization_id_operation_request_key_key"
  ON "appointment_idempotencies"("organization_id", "operation", "request_key");
CREATE INDEX "appointment_idempotencies_organization_id_expires_at_idx"
  ON "appointment_idempotencies"("organization_id", "expires_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "appointment_idempotencies" TO "jormall_app";
ALTER TABLE "appointment_idempotencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_idempotencies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "appointment_idempotencies"
  USING ("organization_id" = current_setting('app.organization_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true)::uuid);
