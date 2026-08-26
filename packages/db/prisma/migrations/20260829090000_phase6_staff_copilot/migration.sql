CREATE TYPE "CopilotInsightType" AS ENUM (
  'DAILY_BRIEFING', 'CUSTOMER_SUMMARY', 'SCHEDULE_GAPS',
  'WAITLIST_MATCHES', 'CALL_QUALITY', 'ANALYTICS'
);
CREATE TYPE "CopilotInsightStatus" AS ENUM ('ACTIVE', 'EXPIRED');
CREATE TYPE "CopilotEvidenceSourceType" AS ENUM (
  'APPOINTMENT', 'CALL', 'CONSENT', 'CUSTOMER', 'HANDOFF', 'MESSAGE',
  'METRIC_SNAPSHOT', 'WAITLIST_ENTRY'
);
CREATE TYPE "CopilotDataClassification" AS ENUM ('INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');
CREATE TYPE "CopilotFeedbackType" AS ENUM ('HELPFUL', 'INCORRECT', 'UNSAFE', 'OUTDATED');

CREATE TABLE "analytics_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "branch_id" UUID,
  "metric_key" VARCHAR(80) NOT NULL,
  "definition_version" INTEGER NOT NULL DEFAULT 1,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "value" DECIMAL(20,4) NOT NULL,
  "dimensions" JSONB NOT NULL,
  "data_watermark" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "analytics_snapshots_window" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "analytics_snapshots_known_metric" CHECK ("metric_key" IN (
    'APPOINTMENTS_TOTAL', 'CANCELLATIONS_TOTAL', 'NO_SHOWS_TOTAL', 'UNCONFIRMED_TOTAL',
    'ACTIVE_WAITLIST_TOTAL', 'FAILED_MESSAGES_TOTAL', 'OPEN_HANDOFFS_TOTAL',
    'MISSED_CALLS_TOTAL', 'SCHEDULED_MINUTES'
  ))
);

CREATE TABLE "copilot_insights" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "membership_id" UUID,
  "prompt_configuration_id" UUID,
  "insight_type" "CopilotInsightType" NOT NULL,
  "status" "CopilotInsightStatus" NOT NULL DEFAULT 'ACTIVE',
  "subject_type" VARCHAR(40),
  "subject_id" UUID,
  "locale" "SupportedLocale" NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "statements" JSONB NOT NULL,
  "model_identifier" VARCHAR(160) NOT NULL,
  "prompt_version" INTEGER NOT NULL,
  "knowledge_version_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "confidence" DOUBLE PRECISION NOT NULL,
  "data_watermark" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "generation_key" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "copilot_insights_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "copilot_insights_confidence" CHECK ("confidence" BETWEEN 0 AND 1),
  CONSTRAINT "copilot_insights_generation_key" CHECK ("generation_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "copilot_insights_expiry" CHECK ("expires_at" > "data_watermark")
);

CREATE TABLE "copilot_insight_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "insight_id" UUID NOT NULL,
  "source_type" "CopilotEvidenceSourceType" NOT NULL,
  "source_id" UUID NOT NULL,
  "label" VARCHAR(240) NOT NULL,
  "href" VARCHAR(500) NOT NULL,
  "classification" "CopilotDataClassification" NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "copilot_insight_sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "copilot_feedback" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "insight_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "feedback_type" "CopilotFeedbackType" NOT NULL,
  "comment" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "copilot_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "analytics_snapshots_organization_id_id_key" ON "analytics_snapshots"("organization_id", "id");
CREATE INDEX "analytics_snapshots_organization_id_metric_key_starts_at_en_idx" ON "analytics_snapshots"("organization_id", "metric_key", "starts_at", "ends_at");
CREATE UNIQUE INDEX "copilot_insights_organization_id_id_key" ON "copilot_insights"("organization_id", "id");
CREATE UNIQUE INDEX "copilot_insights_organization_id_generation_key_key" ON "copilot_insights"("organization_id", "generation_key");
CREATE INDEX "copilot_insights_organization_id_actor_user_id_insight_type_idx" ON "copilot_insights"("organization_id", "actor_user_id", "insight_type", "created_at");
CREATE INDEX "copilot_insights_organization_id_subject_type_subject_id_cr_idx" ON "copilot_insights"("organization_id", "subject_type", "subject_id", "created_at");
CREATE UNIQUE INDEX "copilot_insight_sources_organization_id_id_key" ON "copilot_insight_sources"("organization_id", "id");
CREATE UNIQUE INDEX "copilot_insight_sources_organization_id_insight_id_source_t_key" ON "copilot_insight_sources"("organization_id", "insight_id", "source_type", "source_id");
CREATE INDEX "copilot_insight_sources_organization_id_source_type_source__idx" ON "copilot_insight_sources"("organization_id", "source_type", "source_id");
CREATE UNIQUE INDEX "copilot_feedback_organization_id_id_key" ON "copilot_feedback"("organization_id", "id");
CREATE INDEX "copilot_feedback_organization_id_insight_id_created_at_idx" ON "copilot_feedback"("organization_id", "insight_id", "created_at");

ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "copilot_insights" ADD CONSTRAINT "copilot_insights_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "copilot_insights" ADD CONSTRAINT "copilot_insights_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "copilot_insights" ADD CONSTRAINT "copilot_insights_organization_id_membership_id_fkey" FOREIGN KEY ("organization_id", "membership_id") REFERENCES "organization_memberships"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "copilot_insights" ADD CONSTRAINT "copilot_insights_organization_id_prompt_configuration_id_fkey" FOREIGN KEY ("organization_id", "prompt_configuration_id") REFERENCES "prompt_configurations"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "copilot_insight_sources" ADD CONSTRAINT "copilot_insight_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "copilot_insight_sources" ADD CONSTRAINT "copilot_insight_sources_organization_id_insight_id_fkey" FOREIGN KEY ("organization_id", "insight_id") REFERENCES "copilot_insights"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "copilot_feedback" ADD CONSTRAINT "copilot_feedback_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "copilot_feedback" ADD CONSTRAINT "copilot_feedback_organization_id_insight_id_fkey" FOREIGN KEY ("organization_id", "insight_id") REFERENCES "copilot_insights"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "copilot_feedback" ADD CONSTRAINT "copilot_feedback_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

GRANT SELECT, INSERT ON "analytics_snapshots", "copilot_insights", "copilot_insight_sources", "copilot_feedback" TO jormall_app;

ALTER TABLE "analytics_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "analytics_snapshots_tenant_isolation" ON "analytics_snapshots" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "copilot_insights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_insights" FORCE ROW LEVEL SECURITY;
CREATE POLICY "copilot_insights_tenant_isolation" ON "copilot_insights" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "copilot_insight_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_insight_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "copilot_insight_sources_tenant_isolation" ON "copilot_insight_sources" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "copilot_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_feedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY "copilot_feedback_tenant_isolation" ON "copilot_feedback" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

INSERT INTO "permissions" ("id", "code", "name_en", "name_ar")
VALUES (gen_random_uuid(), 'recordings.read', 'Read consented call records', 'عرض سجلات المكالمات المصرح بها')
ON CONFLICT ("code") DO UPDATE SET "name_en" = EXCLUDED."name_en", "name_ar" = EXCLUDED."name_ar";

WITH role_grants ("role_key", "permission_code", "scope") AS (
  VALUES
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'recordings.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'recordings.read', 'ASSIGNED_BRANCHES'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'reports.read', 'ASSIGNED_BRANCHES'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'customers.read', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'consent.read', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'conversations.read', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'recordings.read', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'reports.read', 'SELF'::"PermissionScope")
)
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id", "scope")
SELECT role."organization_id", role."id", permission."id", role_grants."scope"
FROM role_grants
JOIN "roles" role ON role."system_key" = role_grants."role_key"
JOIN "permissions" permission ON permission."code" = role_grants."permission_code"
ON CONFLICT ("organization_id", "role_id", "permission_id") DO UPDATE SET "scope" = EXCLUDED."scope";

CREATE FUNCTION prevent_copilot_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only Copilot evidence', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "analytics_snapshots_no_mutation" BEFORE UPDATE OR DELETE ON "analytics_snapshots" FOR EACH ROW EXECUTE FUNCTION prevent_copilot_evidence_mutation();
CREATE TRIGGER "copilot_insights_no_mutation" BEFORE UPDATE OR DELETE ON "copilot_insights" FOR EACH ROW EXECUTE FUNCTION prevent_copilot_evidence_mutation();
CREATE TRIGGER "copilot_insight_sources_no_mutation" BEFORE UPDATE OR DELETE ON "copilot_insight_sources" FOR EACH ROW EXECUTE FUNCTION prevent_copilot_evidence_mutation();
CREATE TRIGGER "copilot_feedback_no_mutation" BEFORE UPDATE OR DELETE ON "copilot_feedback" FOR EACH ROW EXECUTE FUNCTION prevent_copilot_evidence_mutation();
