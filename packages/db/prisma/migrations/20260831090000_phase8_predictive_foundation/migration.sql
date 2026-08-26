CREATE TYPE "PredictiveCapability" AS ENUM (
  'NO_SHOW', 'DEMAND_FORECAST', 'STAFFING', 'SCHEDULE_REFLOW',
  'SERVICE_PROVIDER_RECOMMENDATION'
);
CREATE TYPE "PredictiveJobType" AS ENUM (
  'DATA_AUDIT', 'FEATURE_COMPUTE', 'GENERATE', 'BACKTEST', 'DRIFT'
);
CREATE TYPE "PredictiveJobStatus" AS ENUM (
  'PENDING', 'CLAIMED', 'ENQUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER'
);
CREATE TYPE "PredictivePredictionStatus" AS ENUM ('GENERATED', 'REFUSED');
CREATE TYPE "PredictiveRefusalReason" AS ENUM (
  'CAPABILITY_DISABLED', 'INSUFFICIENT_SAMPLE', 'INSUFFICIENT_POSITIVES',
  'INSUFFICIENT_HISTORY_SPAN', 'NO_ELIGIBLE_TARGET', 'NO_VALID_CANDIDATE',
  'MISSING_SCHEDULE_CONFIGURATION', 'MODEL_DEGRADED'
);
CREATE TYPE "PredictiveEvaluationType" AS ENUM ('OFFLINE', 'BACKTEST');
CREATE TYPE "PredictiveEvaluationOutcome" AS ENUM ('PASSED', 'FAILED', 'INSUFFICIENT');
CREATE TYPE "PredictiveDriftStatus" AS ENUM ('STABLE', 'WATCH', 'ALERT', 'INSUFFICIENT');
CREATE TYPE "PredictiveFeedbackType" AS ENUM ('HELPFUL', 'INCORRECT', 'UNSAFE', 'OUTDATED');
CREATE TYPE "OperationalCalendarEventType" AS ENUM ('HOLIDAY', 'CLOSURE', 'SPECIAL_OPEN');

CREATE TABLE "predictive_capability_settings" (
  "organization_id" UUID NOT NULL,
  "capability" "PredictiveCapability" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "predictive_capability_settings_pkey" PRIMARY KEY ("organization_id", "capability"),
  CONSTRAINT "predictive_capability_settings_version" CHECK ("version" > 0)
);

CREATE TABLE "predictive_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "membership_id" UUID,
  "support_access_id" UUID,
  "capability" "PredictiveCapability" NOT NULL,
  "job_type" "PredictiveJobType" NOT NULL,
  "status" "PredictiveJobStatus" NOT NULL DEFAULT 'PENDING',
  "idempotency_key" VARCHAR(160) NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "branch_id" UUID,
  "appointment_id" UUID,
  "service_id" UUID,
  "parameters" JSONB NOT NULL,
  "total_rows" INTEGER NOT NULL DEFAULT 0,
  "processed_rows" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 4,
  "claimed_at" TIMESTAMPTZ(3),
  "claimed_by" VARCHAR(120),
  "enqueued_at" TIMESTAMPTZ(3),
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "safe_error_code" VARCHAR(100),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "predictive_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "predictive_jobs_fingerprint" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "predictive_jobs_counts" CHECK (
    "total_rows" >= 0 AND "processed_rows" >= 0 AND "attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 10
  ),
  CONSTRAINT "predictive_jobs_parameters_object" CHECK (jsonb_typeof("parameters") = 'object')
);

CREATE TABLE "predictive_data_audits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "capability" "PredictiveCapability" NOT NULL,
  "branch_id" UUID,
  "eligible" BOOLEAN NOT NULL,
  "refusal_reason" "PredictiveRefusalReason",
  "sample_size" INTEGER NOT NULL,
  "history_starts_at" TIMESTAMPTZ(3),
  "history_ends_at" TIMESTAMPTZ(3),
  "counts" JSONB NOT NULL,
  "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "data_watermark" TIMESTAMPTZ(3) NOT NULL,
  "audit_checksum" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "predictive_data_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "predictive_data_audits_sample" CHECK ("sample_size" >= 0),
  CONSTRAINT "predictive_data_audits_checksum" CHECK ("audit_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "predictive_data_audits_counts_object" CHECK (jsonb_typeof("counts") = 'object'),
  CONSTRAINT "predictive_data_audits_refusal" CHECK (
    ("eligible" AND "refusal_reason" IS NULL) OR (NOT "eligible" AND "refusal_reason" IS NOT NULL)
  )
);

CREATE TABLE "predictive_feature_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "capability" "PredictiveCapability" NOT NULL,
  "subject_type" VARCHAR(40) NOT NULL,
  "subject_id" UUID,
  "as_of" TIMESTAMPTZ(3) NOT NULL,
  "features" JSONB NOT NULL,
  "feature_hash" CHAR(64) NOT NULL,
  "source_watermark" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "predictive_feature_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "predictive_feature_snapshots_hash" CHECK ("feature_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "predictive_feature_snapshots_features_object" CHECK (jsonb_typeof("features") = 'object')
);

CREATE TABLE "predictive_model_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "capability" "PredictiveCapability" NOT NULL,
  "algorithm_identifier" VARCHAR(160) NOT NULL,
  "version" INTEGER NOT NULL,
  "feature_definition_version" INTEGER NOT NULL,
  "label_definition_version" INTEGER NOT NULL,
  "training_starts_at" TIMESTAMPTZ(3),
  "training_ends_at" TIMESTAMPTZ(3),
  "data_watermark" TIMESTAMPTZ(3) NOT NULL,
  "parameters" JSONB NOT NULL,
  "sample_size" INTEGER NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "predictive_model_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "predictive_model_versions_positive" CHECK (
    "version" > 0 AND "feature_definition_version" > 0 AND "label_definition_version" > 0 AND "sample_size" >= 0
  ),
  CONSTRAINT "predictive_model_versions_window" CHECK (
    "training_starts_at" IS NULL OR "training_ends_at" IS NULL OR "training_ends_at" > "training_starts_at"
  ),
  CONSTRAINT "predictive_model_versions_checksum" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "predictive_model_versions_parameters_object" CHECK (jsonb_typeof("parameters") = 'object')
);

CREATE TABLE "predictions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "job_id" UUID,
  "model_version_id" UUID,
  "feature_snapshot_id" UUID,
  "capability" "PredictiveCapability" NOT NULL,
  "status" "PredictivePredictionStatus" NOT NULL,
  "branch_id" UUID,
  "provider_id" UUID,
  "service_id" UUID,
  "subject_type" VARCHAR(40) NOT NULL,
  "subject_id" UUID,
  "estimate" DOUBLE PRECISION,
  "lower_bound" DOUBLE PRECISION,
  "upper_bound" DOUBLE PRECISION,
  "refusal_reason" "PredictiveRefusalReason",
  "sample_size" INTEGER NOT NULL,
  "model_identifier" VARCHAR(160) NOT NULL,
  "model_version" INTEGER NOT NULL,
  "explanation" JSONB NOT NULL,
  "details" JSONB NOT NULL,
  "as_of" TIMESTAMPTZ(3) NOT NULL,
  "horizon_starts_at" TIMESTAMPTZ(3),
  "horizon_ends_at" TIMESTAMPTZ(3),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "generation_key" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "predictions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "predictions_sample" CHECK ("sample_size" >= 0),
  CONSTRAINT "predictions_model_version" CHECK ("model_version" > 0),
  CONSTRAINT "predictions_generation_key" CHECK ("generation_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "predictions_explanation_array" CHECK (jsonb_typeof("explanation") = 'array'),
  CONSTRAINT "predictions_details_object" CHECK (jsonb_typeof("details") = 'object'),
  CONSTRAINT "predictions_bounds" CHECK (
    ("lower_bound" IS NULL OR "estimate" IS NULL OR "lower_bound" <= "estimate") AND
    ("upper_bound" IS NULL OR "estimate" IS NULL OR "upper_bound" >= "estimate")
  ),
  CONSTRAINT "predictions_no_show_score" CHECK (
    "capability" <> 'NO_SHOW' OR "estimate" IS NULL OR "estimate" BETWEEN 0 AND 1
  ),
  CONSTRAINT "predictions_horizon" CHECK (
    "horizon_starts_at" IS NULL OR "horizon_ends_at" IS NULL OR "horizon_ends_at" > "horizon_starts_at"
  ),
  CONSTRAINT "predictions_outcome" CHECK (
    ("status" = 'GENERATED' AND "estimate" IS NOT NULL AND "lower_bound" IS NOT NULL AND "upper_bound" IS NOT NULL AND "refusal_reason" IS NULL) OR
    ("status" = 'REFUSED' AND "estimate" IS NULL AND "lower_bound" IS NULL AND "upper_bound" IS NULL AND "refusal_reason" IS NOT NULL)
  ),
  CONSTRAINT "predictions_expiry" CHECK ("expires_at" > "as_of")
);

CREATE TABLE "predictive_evaluation_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "model_version_id" UUID,
  "capability" "PredictiveCapability" NOT NULL,
  "run_type" "PredictiveEvaluationType" NOT NULL,
  "outcome" "PredictiveEvaluationOutcome" NOT NULL,
  "branch_id" UUID,
  "sample_size" INTEGER NOT NULL,
  "starts_at" TIMESTAMPTZ(3),
  "ends_at" TIMESTAMPTZ(3),
  "metrics" JSONB NOT NULL,
  "data_watermark" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "predictive_evaluation_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "predictive_evaluation_runs_sample" CHECK ("sample_size" >= 0),
  CONSTRAINT "predictive_evaluation_runs_window" CHECK (
    "starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"
  ),
  CONSTRAINT "predictive_evaluation_runs_metrics_object" CHECK (jsonb_typeof("metrics") = 'object')
);

CREATE TABLE "predictive_drift_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "model_version_id" UUID,
  "capability" "PredictiveCapability" NOT NULL,
  "branch_id" UUID,
  "status" "PredictiveDriftStatus" NOT NULL,
  "score" DOUBLE PRECISION,
  "sample_size" INTEGER NOT NULL,
  "baseline_starts_at" TIMESTAMPTZ(3),
  "baseline_ends_at" TIMESTAMPTZ(3),
  "current_starts_at" TIMESTAMPTZ(3),
  "current_ends_at" TIMESTAMPTZ(3),
  "metrics" JSONB NOT NULL,
  "data_watermark" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "predictive_drift_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "predictive_drift_runs_sample" CHECK ("sample_size" >= 0),
  CONSTRAINT "predictive_drift_runs_score" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 1),
  CONSTRAINT "predictive_drift_runs_metrics_object" CHECK (jsonb_typeof("metrics") = 'object')
);

CREATE TABLE "predictive_feedback" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "prediction_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "feedback_type" "PredictiveFeedbackType" NOT NULL,
  "comment" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "predictive_feedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operational_calendar_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "branch_id" UUID,
  "event_type" "OperationalCalendarEventType" NOT NULL,
  "local_date" DATE NOT NULL,
  "label_en" VARCHAR(160) NOT NULL,
  "label_ar" VARCHAR(160) NOT NULL,
  "demand_adjustment" DOUBLE PRECISION,
  "version" INTEGER NOT NULL DEFAULT 1,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operational_calendar_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_calendar_events_version" CHECK ("version" > 0),
  CONSTRAINT "operational_calendar_events_adjustment" CHECK (
    "demand_adjustment" IS NULL OR "demand_adjustment" BETWEEN 0 AND 2
  ),
  CONSTRAINT "operational_calendar_events_labels" CHECK (
    length(btrim("label_en")) > 0 AND length(btrim("label_ar")) > 0
  )
);

CREATE UNIQUE INDEX "predictive_jobs_organization_id_id_key" ON "predictive_jobs"("organization_id", "id");
CREATE UNIQUE INDEX "platform_support_accesses_organization_id_id_key" ON "platform_support_accesses"("organization_id", "id");
CREATE UNIQUE INDEX "predictive_jobs_organization_id_idempotency_key_key" ON "predictive_jobs"("organization_id", "idempotency_key");
CREATE INDEX "predictive_jobs_organization_id_status_created_at_idx" ON "predictive_jobs"("organization_id", "status", "created_at");
CREATE INDEX "predictive_jobs_organization_id_capability_created_at_idx" ON "predictive_jobs"("organization_id", "capability", "created_at");
CREATE INDEX "predictive_jobs_organization_id_branch_id_created_at_idx" ON "predictive_jobs"("organization_id", "branch_id", "created_at");
CREATE UNIQUE INDEX "predictive_data_audits_organization_id_id_key" ON "predictive_data_audits"("organization_id", "id");
CREATE UNIQUE INDEX "predictive_data_audits_organization_id_job_id_key" ON "predictive_data_audits"("organization_id", "job_id");
CREATE INDEX "predictive_data_audits_organization_id_capability_created_at_idx" ON "predictive_data_audits"("organization_id", "capability", "created_at");
CREATE UNIQUE INDEX "predictive_feature_snapshots_organization_id_id_key" ON "predictive_feature_snapshots"("organization_id", "id");
CREATE UNIQUE INDEX "predictive_feature_snapshots_organization_id_feature_hash_key" ON "predictive_feature_snapshots"("organization_id", "feature_hash");
CREATE INDEX "predictive_feature_snapshots_subject_idx" ON "predictive_feature_snapshots"("organization_id", "capability", "subject_type", "subject_id", "as_of");
CREATE UNIQUE INDEX "predictive_model_versions_organization_id_id_key" ON "predictive_model_versions"("organization_id", "id");
CREATE UNIQUE INDEX "predictive_model_versions_organization_id_capability_version_key" ON "predictive_model_versions"("organization_id", "capability", "version");
CREATE UNIQUE INDEX "predictive_model_versions_organization_id_checksum_key" ON "predictive_model_versions"("organization_id", "checksum");
CREATE INDEX "predictive_model_versions_organization_id_capability_is_active_idx" ON "predictive_model_versions"("organization_id", "capability", "is_active");
CREATE UNIQUE INDEX "predictive_model_versions_one_active" ON "predictive_model_versions"("organization_id", "capability") WHERE "is_active";
CREATE UNIQUE INDEX "predictions_organization_id_id_key" ON "predictions"("organization_id", "id");
CREATE UNIQUE INDEX "predictions_organization_id_generation_key_key" ON "predictions"("organization_id", "generation_key");
CREATE INDEX "predictions_organization_id_capability_created_at_idx" ON "predictions"("organization_id", "capability", "created_at");
CREATE INDEX "predictions_organization_id_branch_id_created_at_idx" ON "predictions"("organization_id", "branch_id", "created_at");
CREATE INDEX "predictions_organization_id_provider_id_created_at_idx" ON "predictions"("organization_id", "provider_id", "created_at");
CREATE INDEX "predictions_subject_idx" ON "predictions"("organization_id", "subject_type", "subject_id", "created_at");
CREATE UNIQUE INDEX "predictive_evaluation_runs_organization_id_id_key" ON "predictive_evaluation_runs"("organization_id", "id");
CREATE UNIQUE INDEX "predictive_evaluation_runs_organization_id_job_id_key" ON "predictive_evaluation_runs"("organization_id", "job_id");
CREATE INDEX "predictive_evaluation_runs_capability_idx" ON "predictive_evaluation_runs"("organization_id", "capability", "created_at");
CREATE UNIQUE INDEX "predictive_drift_runs_organization_id_id_key" ON "predictive_drift_runs"("organization_id", "id");
CREATE UNIQUE INDEX "predictive_drift_runs_organization_id_job_id_key" ON "predictive_drift_runs"("organization_id", "job_id");
CREATE INDEX "predictive_drift_runs_capability_idx" ON "predictive_drift_runs"("organization_id", "capability", "created_at");
CREATE UNIQUE INDEX "predictive_feedback_organization_id_id_key" ON "predictive_feedback"("organization_id", "id");
CREATE INDEX "predictive_feedback_prediction_idx" ON "predictive_feedback"("organization_id", "prediction_id", "created_at");
CREATE UNIQUE INDEX "predictive_feedback_actor_once" ON "predictive_feedback"("organization_id", "prediction_id", "actor_user_id", "feedback_type");
CREATE UNIQUE INDEX "operational_calendar_events_organization_id_id_key" ON "operational_calendar_events"("organization_id", "id");
CREATE INDEX "operational_calendar_events_lookup_idx" ON "operational_calendar_events"("organization_id", "branch_id", "local_date", "is_active");
CREATE UNIQUE INDEX "operational_calendar_events_active_branch" ON "operational_calendar_events"("organization_id", "branch_id", "local_date", "event_type") WHERE "is_active" AND "branch_id" IS NOT NULL;
CREATE UNIQUE INDEX "operational_calendar_events_active_org" ON "operational_calendar_events"("organization_id", "local_date", "event_type") WHERE "is_active" AND "branch_id" IS NULL;

ALTER TABLE "predictive_capability_settings" ADD CONSTRAINT "predictive_capability_settings_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "predictive_capability_settings" ADD CONSTRAINT "predictive_capability_settings_updater_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "predictive_jobs" ADD CONSTRAINT "predictive_jobs_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "predictive_jobs" ADD CONSTRAINT "predictive_jobs_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "predictive_jobs" ADD CONSTRAINT "predictive_jobs_membership_fkey" FOREIGN KEY ("organization_id", "membership_id") REFERENCES "organization_memberships"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_jobs" ADD CONSTRAINT "predictive_jobs_support_fkey" FOREIGN KEY ("organization_id", "support_access_id") REFERENCES "platform_support_accesses"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_jobs" ADD CONSTRAINT "predictive_jobs_branch_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_jobs" ADD CONSTRAINT "predictive_jobs_appointment_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_jobs" ADD CONSTRAINT "predictive_jobs_service_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_data_audits" ADD CONSTRAINT "predictive_data_audits_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "predictive_data_audits" ADD CONSTRAINT "predictive_data_audits_job_fkey" FOREIGN KEY ("organization_id", "job_id") REFERENCES "predictive_jobs"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_data_audits" ADD CONSTRAINT "predictive_data_audits_branch_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_feature_snapshots" ADD CONSTRAINT "predictive_feature_snapshots_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "predictive_feature_snapshots" ADD CONSTRAINT "predictive_feature_snapshots_job_fkey" FOREIGN KEY ("organization_id", "job_id") REFERENCES "predictive_jobs"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_model_versions" ADD CONSTRAINT "predictive_model_versions_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_job_fkey" FOREIGN KEY ("organization_id", "job_id") REFERENCES "predictive_jobs"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_model_fkey" FOREIGN KEY ("organization_id", "model_version_id") REFERENCES "predictive_model_versions"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_feature_fkey" FOREIGN KEY ("organization_id", "feature_snapshot_id") REFERENCES "predictive_feature_snapshots"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_branch_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_provider_fkey" FOREIGN KEY ("organization_id", "provider_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_service_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_evaluation_runs" ADD CONSTRAINT "predictive_evaluation_runs_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "predictive_evaluation_runs" ADD CONSTRAINT "predictive_evaluation_runs_job_fkey" FOREIGN KEY ("organization_id", "job_id") REFERENCES "predictive_jobs"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_evaluation_runs" ADD CONSTRAINT "predictive_evaluation_runs_model_fkey" FOREIGN KEY ("organization_id", "model_version_id") REFERENCES "predictive_model_versions"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_evaluation_runs" ADD CONSTRAINT "predictive_evaluation_runs_branch_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_drift_runs" ADD CONSTRAINT "predictive_drift_runs_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "predictive_drift_runs" ADD CONSTRAINT "predictive_drift_runs_job_fkey" FOREIGN KEY ("organization_id", "job_id") REFERENCES "predictive_jobs"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_drift_runs" ADD CONSTRAINT "predictive_drift_runs_model_fkey" FOREIGN KEY ("organization_id", "model_version_id") REFERENCES "predictive_model_versions"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_drift_runs" ADD CONSTRAINT "predictive_drift_runs_branch_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_feedback" ADD CONSTRAINT "predictive_feedback_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "predictive_feedback" ADD CONSTRAINT "predictive_feedback_prediction_fkey" FOREIGN KEY ("organization_id", "prediction_id") REFERENCES "predictions"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "predictive_feedback" ADD CONSTRAINT "predictive_feedback_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "operational_calendar_events" ADD CONSTRAINT "operational_calendar_events_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "operational_calendar_events" ADD CONSTRAINT "operational_calendar_events_branch_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "operational_calendar_events" ADD CONSTRAINT "operational_calendar_events_creator_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

GRANT SELECT, INSERT, UPDATE ON "predictive_capability_settings", "predictive_jobs", "predictive_model_versions" TO jormall_app;
GRANT SELECT, INSERT ON "predictive_data_audits", "predictive_feature_snapshots", "predictions", "predictive_evaluation_runs", "predictive_drift_runs", "predictive_feedback" TO jormall_app;
GRANT SELECT, INSERT, UPDATE ON "operational_calendar_events" TO jormall_app;
GRANT SELECT, UPDATE ON "predictive_jobs" TO jormall_relay;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'predictive_capability_settings', 'predictive_jobs', 'predictive_data_audits',
    'predictive_feature_snapshots', 'predictive_model_versions', 'predictions',
    'predictive_evaluation_runs', 'predictive_drift_runs', 'predictive_feedback',
    'operational_calendar_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = NULLIF(CURRENT_SETTING(''app.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(CURRENT_SETTING(''app.organization_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END $$;

CREATE POLICY "predictive_jobs_relay_access" ON "predictive_jobs" TO jormall_relay
USING (true) WITH CHECK (true);

CREATE FUNCTION prevent_predictive_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only predictive evidence', TG_TABLE_NAME;
END $$;
CREATE TRIGGER predictive_data_audits_no_mutation BEFORE UPDATE OR DELETE ON "predictive_data_audits" FOR EACH ROW EXECUTE FUNCTION prevent_predictive_evidence_mutation();
CREATE TRIGGER predictive_feature_snapshots_no_mutation BEFORE UPDATE OR DELETE ON "predictive_feature_snapshots" FOR EACH ROW EXECUTE FUNCTION prevent_predictive_evidence_mutation();
CREATE TRIGGER predictions_no_mutation BEFORE UPDATE OR DELETE ON "predictions" FOR EACH ROW EXECUTE FUNCTION prevent_predictive_evidence_mutation();
CREATE TRIGGER predictive_evaluation_runs_no_mutation BEFORE UPDATE OR DELETE ON "predictive_evaluation_runs" FOR EACH ROW EXECUTE FUNCTION prevent_predictive_evidence_mutation();
CREATE TRIGGER predictive_drift_runs_no_mutation BEFORE UPDATE OR DELETE ON "predictive_drift_runs" FOR EACH ROW EXECUTE FUNCTION prevent_predictive_evidence_mutation();
CREATE TRIGGER predictive_feedback_no_mutation BEFORE UPDATE OR DELETE ON "predictive_feedback" FOR EACH ROW EXECUTE FUNCTION prevent_predictive_evidence_mutation();

INSERT INTO "permissions" ("id", "code", "name_en", "name_ar") VALUES
  (gen_random_uuid(), 'predictions.read', 'Read predictive insights', 'عرض الرؤى التنبؤية'),
  (gen_random_uuid(), 'predictions.run', 'Run predictive jobs', 'تشغيل مهام التنبؤ'),
  (gen_random_uuid(), 'predictions.configure', 'Configure predictive capabilities', 'إعداد قدرات التنبؤ'),
  (gen_random_uuid(), 'predictions.feedback', 'Record prediction feedback', 'تسجيل ملاحظات التنبؤ')
ON CONFLICT ("code") DO UPDATE SET "name_en" = EXCLUDED."name_en", "name_ar" = EXCLUDED."name_ar";

WITH grants(role_key, permission_code, scope) AS (VALUES
  ('ORGANIZATION_OWNER'::"TenantRoleKey", 'predictions.read', 'ORGANIZATION'::"PermissionScope"),
  ('ORGANIZATION_OWNER'::"TenantRoleKey", 'predictions.run', 'ORGANIZATION'::"PermissionScope"),
  ('ORGANIZATION_OWNER'::"TenantRoleKey", 'predictions.configure', 'ORGANIZATION'::"PermissionScope"),
  ('ORGANIZATION_OWNER'::"TenantRoleKey", 'predictions.feedback', 'ORGANIZATION'::"PermissionScope"),
  ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'predictions.read', 'ASSIGNED_BRANCHES'::"PermissionScope"),
  ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'predictions.run', 'ASSIGNED_BRANCHES'::"PermissionScope"),
  ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'predictions.feedback', 'ASSIGNED_BRANCHES'::"PermissionScope"),
  ('SECRETARY'::"TenantRoleKey", 'predictions.read', 'ASSIGNED_BRANCHES'::"PermissionScope"),
  ('SECRETARY'::"TenantRoleKey", 'predictions.feedback', 'ASSIGNED_BRANCHES'::"PermissionScope"),
  ('PROVIDER'::"TenantRoleKey", 'predictions.read', 'SELF'::"PermissionScope"),
  ('PROVIDER'::"TenantRoleKey", 'predictions.feedback', 'SELF'::"PermissionScope")
)
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id", "scope")
SELECT role."organization_id", role."id", permission."id", grants.scope
FROM grants
JOIN "roles" role ON role."system_key" = grants.role_key
JOIN "permissions" permission ON permission."code" = grants.permission_code
ON CONFLICT ("organization_id", "role_id", "permission_id") DO UPDATE SET "scope" = EXCLUDED."scope";

INSERT INTO "predictive_capability_settings" (
  "organization_id", "capability", "enabled", "version", "updated_by_user_id"
)
SELECT organization."id", capability.value::"PredictiveCapability", false, 1, organization."created_by_user_id"
FROM "organizations" organization
CROSS JOIN unnest(enum_range(NULL::"PredictiveCapability")) AS capability(value)
ON CONFLICT ("organization_id", "capability") DO NOTHING;
