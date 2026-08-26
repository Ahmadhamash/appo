CREATE TYPE "ImportKind" AS ENUM ('CUSTOMERS', 'STAFF', 'SERVICES', 'APPOINTMENTS');
CREATE TYPE "ImportBatchStatus" AS ENUM ('STAGING', 'DRY_RUN_READY', 'COMMITTING', 'COMMITTED', 'PARTIAL', 'ROLLED_BACK', 'FAILED');
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'INVALID', 'DUPLICATE', 'IMPORTED', 'FAILED', 'ROLLED_BACK');
CREATE TYPE "AttributionSource" AS ENUM ('PUBLIC_BOOKING', 'WEBSITE_CHATBOT', 'WHATSAPP_AI', 'VOICE_AI', 'STAFF_MANUAL', 'CAMPAIGN', 'WAITLIST_CONVERSION', 'MISSED_CALL_RECOVERY');
CREATE TYPE "DataExportType" AS ENUM ('CUSTOMERS', 'APPOINTMENTS', 'AUDIT_LOG', 'REPORT');
CREATE TYPE "DataExportStatus" AS ENUM ('READY', 'EXPIRED', 'FAILED');

CREATE TABLE "import_batches" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL, "kind" "ImportKind" NOT NULL,
  "status" "ImportBatchStatus" NOT NULL DEFAULT 'STAGING', "idempotency_key" VARCHAR(160) NOT NULL,
  "file_name" VARCHAR(240) NOT NULL, "file_digest" CHAR(64) NOT NULL,
  "total_rows" INTEGER NOT NULL DEFAULT 0, "valid_rows" INTEGER NOT NULL DEFAULT 0,
  "invalid_rows" INTEGER NOT NULL DEFAULT 0, "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
  "imported_rows" INTEGER NOT NULL DEFAULT 0, "failed_rows" INTEGER NOT NULL DEFAULT 0,
  "rollback_summary" JSONB, "committed_at" TIMESTAMPTZ(3), "rolled_back_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_batches_digest" CHECK ("file_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "import_batches_counts" CHECK ("total_rows" >= 0 AND "valid_rows" >= 0 AND "invalid_rows" >= 0 AND "duplicate_rows" >= 0 AND "imported_rows" >= 0 AND "failed_rows" >= 0)
);
CREATE TABLE "import_rows" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL,
  "batch_id" UUID NOT NULL, "row_number" INTEGER NOT NULL, "external_key" VARCHAR(160),
  "payload" JSONB NOT NULL, "payload_digest" CHAR(64) NOT NULL, "status" "ImportRowStatus" NOT NULL,
  "error_code" VARCHAR(100), "error_field" VARCHAR(100), "safe_message" VARCHAR(300),
  "target_type" VARCHAR(80), "target_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_rows_row_number" CHECK ("row_number" > 1),
  CONSTRAINT "import_rows_digest" CHECK ("payload_digest" ~ '^[0-9a-f]{64}$')
);
CREATE TABLE "attribution_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL,
  "appointment_id" UUID, "customer_id" UUID, "source" "AttributionSource" NOT NULL,
  "source_detail" VARCHAR(200), "campaign_source" VARCHAR(120), "campaign_medium" VARCHAR(120),
  "campaign_name" VARCHAR(160), "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "report_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL, "metric_key" VARCHAR(80) NOT NULL,
  "definition_version" INTEGER NOT NULL DEFAULT 1, "timezone" VARCHAR(100) NOT NULL,
  "starts_at" TIMESTAMPTZ(3) NOT NULL, "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "dimensions" JSONB NOT NULL, "result" JSONB NOT NULL, "data_watermark" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_runs_window" CHECK ("ends_at" > "starts_at")
);
CREATE TABLE "data_export_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL, "type" "DataExportType" NOT NULL,
  "status" "DataExportStatus" NOT NULL DEFAULT 'READY', "parameters" JSONB NOT NULL,
  "row_count" INTEGER, "expires_at" TIMESTAMPTZ(3) NOT NULL, "downloaded_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "data_export_jobs_expiry" CHECK ("expires_at" > "created_at")
);
CREATE TABLE "platform_audit_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "actor_user_id" UUID NOT NULL,
  "action" VARCHAR(120) NOT NULL, "reason" VARCHAR(500) NOT NULL, "metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "import_batches_organization_id_id_key" ON "import_batches"("organization_id", "id");
CREATE UNIQUE INDEX "import_batches_organization_id_idempotency_key_key" ON "import_batches"("organization_id", "idempotency_key");
CREATE INDEX "import_batches_organization_id_created_at_idx" ON "import_batches"("organization_id", "created_at");
CREATE UNIQUE INDEX "import_rows_organization_id_id_key" ON "import_rows"("organization_id", "id");
CREATE UNIQUE INDEX "import_rows_organization_id_batch_id_row_number_key" ON "import_rows"("organization_id", "batch_id", "row_number");
CREATE INDEX "import_rows_organization_id_batch_id_status_row_number_idx" ON "import_rows"("organization_id", "batch_id", "status", "row_number");
CREATE UNIQUE INDEX "attribution_events_organization_id_id_key" ON "attribution_events"("organization_id", "id");
CREATE INDEX "attribution_events_organization_id_source_occurred_at_idx" ON "attribution_events"("organization_id", "source", "occurred_at");
CREATE INDEX "attribution_events_organization_id_appointment_id_occurred_at_idx" ON "attribution_events"("organization_id", "appointment_id", "occurred_at");
CREATE UNIQUE INDEX "report_runs_organization_id_id_key" ON "report_runs"("organization_id", "id");
CREATE INDEX "report_runs_organization_id_metric_key_created_at_idx" ON "report_runs"("organization_id", "metric_key", "created_at");
CREATE UNIQUE INDEX "data_export_jobs_organization_id_id_key" ON "data_export_jobs"("organization_id", "id");
CREATE INDEX "data_export_jobs_organization_id_actor_user_id_created_at_idx" ON "data_export_jobs"("organization_id", "actor_user_id", "created_at");
CREATE INDEX "platform_audit_events_actor_user_id_created_at_idx" ON "platform_audit_events"("actor_user_id", "created_at");

ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_appointment_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_customer_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "data_export_jobs" ADD CONSTRAINT "data_export_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "data_export_jobs" ADD CONSTRAINT "data_export_jobs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

GRANT SELECT, INSERT, UPDATE ON "import_batches", "import_rows", "data_export_jobs" TO jormall_app;
GRANT SELECT, INSERT ON "attribution_events", "report_runs" TO jormall_app;
DO $$ DECLARE table_name text; BEGIN FOREACH table_name IN ARRAY ARRAY['import_batches','import_rows','attribution_events','report_runs','data_export_jobs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  EXECUTE format('CREATE POLICY %I ON %I USING (organization_id = NULLIF(CURRENT_SETTING(''app.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(CURRENT_SETTING(''app.organization_id'', true), '''')::uuid)', table_name || '_tenant_isolation', table_name);
END LOOP; END $$;

INSERT INTO "permissions" ("id", "code", "name_en", "name_ar") VALUES
  (gen_random_uuid(), 'imports.manage', 'Manage safe data imports', 'إدارة استيراد البيانات الآمن'),
  (gen_random_uuid(), 'exports.manage', 'Create protected data exports', 'إنشاء تصدير بيانات محمي')
ON CONFLICT ("code") DO UPDATE SET "name_en" = EXCLUDED."name_en", "name_ar" = EXCLUDED."name_ar";
WITH grants(role_key, permission_code, scope) AS (VALUES
  ('ORGANIZATION_OWNER'::"TenantRoleKey", 'imports.manage', 'ORGANIZATION'::"PermissionScope"),
  ('ORGANIZATION_OWNER'::"TenantRoleKey", 'exports.manage', 'ORGANIZATION'::"PermissionScope"),
  ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'imports.manage', 'ORGANIZATION'::"PermissionScope"),
  ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'exports.manage', 'ORGANIZATION'::"PermissionScope"),
  ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'audit.read', 'ASSIGNED_BRANCHES'::"PermissionScope")
) INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id", "scope")
SELECT role.organization_id, role.id, permission.id, grants.scope FROM grants
JOIN roles role ON role.system_key = grants.role_key JOIN permissions permission ON permission.code = grants.permission_code
ON CONFLICT ("organization_id", "role_id", "permission_id") DO UPDATE SET "scope" = EXCLUDED."scope";

INSERT INTO "attribution_events" ("organization_id", "appointment_id", "customer_id", "source", "source_detail", "occurred_at")
SELECT "organization_id", "id", "customer_id",
  CASE "source"::text WHEN 'PUBLIC_BOOKING' THEN 'PUBLIC_BOOKING' WHEN 'WEBSITE_AI' THEN 'WEBSITE_CHATBOT'
    WHEN 'WHATSAPP_AI' THEN 'WHATSAPP_AI' WHEN 'VOICE_AI' THEN 'VOICE_AI' ELSE 'STAFF_MANUAL' END::"AttributionSource",
  "source_detail", "created_at" FROM "appointments";

CREATE FUNCTION prevent_phase7_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION '% is append-only evidence', TG_TABLE_NAME;
END $$;
CREATE TRIGGER attribution_events_no_mutation BEFORE UPDATE OR DELETE ON "attribution_events" FOR EACH ROW EXECUTE FUNCTION prevent_phase7_evidence_mutation();
CREATE TRIGGER report_runs_no_mutation BEFORE UPDATE OR DELETE ON "report_runs" FOR EACH ROW EXECUTE FUNCTION prevent_phase7_evidence_mutation();
CREATE TRIGGER platform_audit_events_no_mutation BEFORE UPDATE OR DELETE ON "platform_audit_events" FOR EACH ROW EXECUTE FUNCTION prevent_phase7_evidence_mutation();
