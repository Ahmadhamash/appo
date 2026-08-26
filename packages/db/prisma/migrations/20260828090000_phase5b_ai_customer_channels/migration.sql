-- Phase 5B: shared website, WhatsApp and provider-neutral voice AI transports.

CREATE TYPE "AICustomerChannel" AS ENUM ('WEBSITE', 'WHATSAPP', 'VOICE');
CREATE TYPE "AIChannelSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'EXPIRED');
CREATE TYPE "AIChannelPendingActionStatus" AS ENUM ('PENDING', 'DECLINED', 'CONSUMED', 'EXPIRED');
CREATE TYPE "CallDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACTIVE', 'HUMAN_TRANSFER', 'COMPLETED', 'MISSED', 'FAILED');
CREATE TYPE "RecordingConsentStatus" AS ENUM ('NOT_REQUESTED', 'DECLINED', 'GRANTED', 'REVOKED');
CREATE TYPE "CallEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');
CREATE TYPE "CallRecordingStatus" AS ENUM ('PENDING', 'RECORDING', 'STOPPED', 'FAILED');
CREATE TYPE "CallTranscriptSpeaker" AS ENUM ('CUSTOMER', 'ASSISTANT', 'HUMAN', 'SYSTEM');

ALTER TABLE "ai_usage" ADD COLUMN "channel" VARCHAR(40) NOT NULL DEFAULT 'internal';
ALTER TABLE "ai_evaluation_cases" ADD COLUMN "channel" VARCHAR(40) NOT NULL DEFAULT 'shared';
ALTER TABLE "ai_evaluation_cases" ADD COLUMN "replay_fixture" JSONB;

CREATE TABLE "website_widget_configurations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "public_key" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(120) NOT NULL,
  "display_name_en" VARCHAR(160) NOT NULL,
  "display_name_ar" VARCHAR(160) NOT NULL,
  "primary_color" CHAR(7) NOT NULL DEFAULT '#125e46',
  "accent_color" CHAR(7) NOT NULL DEFAULT '#d7f265',
  "allowed_origins" TEXT[] NOT NULL,
  "default_locale" "SupportedLocale" NOT NULL DEFAULT 'en',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "website_widget_configurations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_channel_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "customer_id" UUID,
  "widget_configuration_id" UUID,
  "provider_connection_id" UUID,
  "channel" "AICustomerChannel" NOT NULL,
  "external_key_hash" CHAR(64) NOT NULL,
  "origin" VARCHAR(500),
  "locale" "SupportedLocale" NOT NULL DEFAULT 'en',
  "status" "AIChannelSessionStatus" NOT NULL DEFAULT 'OPEN',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "last_inbound_at" TIMESTAMPTZ(3),
  "last_outbound_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ai_channel_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_channel_pending_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "action_id" UUID NOT NULL,
  "approval_id" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "AIChannelPendingActionStatus" NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ai_channel_pending_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "calls" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "channel_session_id" UUID NOT NULL,
  "provider_connection_id" UUID NOT NULL,
  "customer_id" UUID,
  "provider_call_id" VARCHAR(200) NOT NULL,
  "direction" "CallDirection" NOT NULL DEFAULT 'INBOUND',
  "locale" "SupportedLocale" NOT NULL DEFAULT 'ar',
  "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
  "recording_consent_status" "RecordingConsentStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
  "started_at" TIMESTAMPTZ(3) NOT NULL,
  "answered_at" TIMESTAMPTZ(3),
  "ended_at" TIMESTAMPTZ(3),
  "handoff_reason" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "call_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "call_id" UUID NOT NULL,
  "provider_event_id" VARCHAR(200) NOT NULL,
  "event_type" VARCHAR(80) NOT NULL,
  "sequence" INTEGER,
  "payload_digest" CHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "CallEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "processed_at" TIMESTAMPTZ(3),
  "error_code" VARCHAR(100),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "call_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "call_recordings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "call_id" UUID NOT NULL,
  "consent_event_id" UUID NOT NULL,
  "provider_recording_id" VARCHAR(200),
  "object_reference" VARCHAR(500),
  "status" "CallRecordingStatus" NOT NULL DEFAULT 'PENDING',
  "started_at" TIMESTAMPTZ(3),
  "ended_at" TIMESTAMPTZ(3),
  "retain_until" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "call_transcripts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "call_id" UUID NOT NULL,
  "call_event_id" UUID,
  "speaker" "CallTranscriptSpeaker" NOT NULL,
  "content" TEXT NOT NULL,
  "locale" "SupportedLocale" NOT NULL,
  "is_final" BOOLEAN NOT NULL DEFAULT false,
  "confidence" DOUBLE PRECISION,
  "started_at" TIMESTAMPTZ(3) NOT NULL,
  "ended_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "call_transcripts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "call_summaries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "call_id" UUID NOT NULL,
  "appointment_id" UUID,
  "intent" VARCHAR(300) NOT NULL,
  "outcome" VARCHAR(300) NOT NULL,
  "unresolved_items" TEXT[] NOT NULL,
  "handoff_reason" VARCHAR(500),
  "model_identifier" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "call_summaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "website_widget_configurations_public_key_key" ON "website_widget_configurations"("public_key");
CREATE UNIQUE INDEX "website_widget_configurations_organization_id_id_key" ON "website_widget_configurations"("organization_id", "id");
CREATE INDEX "website_widget_configurations_organization_id_is_active_idx" ON "website_widget_configurations"("organization_id", "is_active");
CREATE UNIQUE INDEX "ai_channel_sessions_conversation_id_key" ON "ai_channel_sessions"("conversation_id");
CREATE UNIQUE INDEX "ai_channel_sessions_organization_id_id_key" ON "ai_channel_sessions"("organization_id", "id");
CREATE UNIQUE INDEX "ai_channel_sessions_organization_id_conversation_id_key" ON "ai_channel_sessions"("organization_id", "conversation_id");
CREATE UNIQUE INDEX "ai_channel_sessions_org_channel_external_key" ON "ai_channel_sessions"("organization_id", "channel", "external_key_hash");
CREATE INDEX "ai_channel_sessions_org_channel_status_updated_idx" ON "ai_channel_sessions"("organization_id", "channel", "status", "updated_at");
CREATE UNIQUE INDEX "ai_channel_pending_actions_action_id_key" ON "ai_channel_pending_actions"("action_id");
CREATE UNIQUE INDEX "ai_channel_pending_actions_approval_id_key" ON "ai_channel_pending_actions"("approval_id");
CREATE UNIQUE INDEX "ai_channel_pending_actions_organization_id_id_key" ON "ai_channel_pending_actions"("organization_id", "id");
CREATE UNIQUE INDEX "ai_channel_pending_actions_org_action_key" ON "ai_channel_pending_actions"("organization_id", "action_id");
CREATE UNIQUE INDEX "ai_channel_pending_actions_org_approval_key" ON "ai_channel_pending_actions"("organization_id", "approval_id");
CREATE INDEX "ai_channel_pending_actions_org_session_status_expiry_idx" ON "ai_channel_pending_actions"("organization_id", "session_id", "status", "expires_at");
CREATE UNIQUE INDEX "calls_channel_session_id_key" ON "calls"("channel_session_id");
CREATE UNIQUE INDEX "calls_organization_id_id_key" ON "calls"("organization_id", "id");
CREATE UNIQUE INDEX "calls_org_channel_session_key" ON "calls"("organization_id", "channel_session_id");
CREATE UNIQUE INDEX "calls_provider_connection_provider_call_key" ON "calls"("provider_connection_id", "provider_call_id");
CREATE INDEX "calls_organization_id_status_started_at_idx" ON "calls"("organization_id", "status", "started_at");
CREATE UNIQUE INDEX "call_events_organization_id_id_key" ON "call_events"("organization_id", "id");
CREATE UNIQUE INDEX "call_events_org_call_provider_event_key" ON "call_events"("organization_id", "call_id", "provider_event_id");
CREATE INDEX "call_events_organization_id_status_occurred_at_idx" ON "call_events"("organization_id", "status", "occurred_at");
CREATE UNIQUE INDEX "call_recordings_organization_id_id_key" ON "call_recordings"("organization_id", "id");
CREATE INDEX "call_recordings_organization_id_call_id_created_at_idx" ON "call_recordings"("organization_id", "call_id", "created_at");
CREATE UNIQUE INDEX "call_transcripts_organization_id_id_key" ON "call_transcripts"("organization_id", "id");
CREATE INDEX "call_transcripts_organization_id_call_id_started_at_idx" ON "call_transcripts"("organization_id", "call_id", "started_at");
CREATE UNIQUE INDEX "call_summaries_call_id_key" ON "call_summaries"("call_id");
CREATE UNIQUE INDEX "call_summaries_organization_id_id_key" ON "call_summaries"("organization_id", "id");
CREATE UNIQUE INDEX "call_summaries_organization_id_call_id_key" ON "call_summaries"("organization_id", "call_id");
CREATE INDEX "call_summaries_organization_id_created_at_idx" ON "call_summaries"("organization_id", "created_at");
CREATE INDEX "ai_usage_organization_id_channel_occurred_at_idx" ON "ai_usage"("organization_id", "channel", "occurred_at");
CREATE INDEX "ai_evaluation_cases_organization_id_channel_active_idx" ON "ai_evaluation_cases"("organization_id", "channel", "is_active");
CREATE UNIQUE INDEX "provider_connections_channel_account_unique" ON "provider_connections"("channel", "provider_account_id") WHERE "provider_account_id" IS NOT NULL;

ALTER TABLE "website_widget_configurations" ADD CONSTRAINT "widget_configurations_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "ai_channel_sessions" ADD CONSTRAINT "ai_channel_sessions_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "ai_channel_sessions" ADD CONSTRAINT "ai_channel_sessions_conversation_tenant_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "ai_conversations"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "ai_channel_sessions" ADD CONSTRAINT "ai_channel_sessions_customer_tenant_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ai_channel_sessions" ADD CONSTRAINT "ai_channel_sessions_widget_tenant_fkey" FOREIGN KEY ("organization_id", "widget_configuration_id") REFERENCES "website_widget_configurations"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ai_channel_sessions" ADD CONSTRAINT "ai_channel_sessions_provider_tenant_fkey" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ai_channel_pending_actions" ADD CONSTRAINT "ai_channel_pending_actions_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "ai_channel_pending_actions" ADD CONSTRAINT "ai_channel_pending_actions_session_tenant_fkey" FOREIGN KEY ("organization_id", "session_id") REFERENCES "ai_channel_sessions"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "ai_channel_pending_actions" ADD CONSTRAINT "ai_channel_pending_actions_action_tenant_fkey" FOREIGN KEY ("organization_id", "action_id") REFERENCES "ai_actions"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ai_channel_pending_actions" ADD CONSTRAINT "ai_channel_pending_actions_approval_tenant_fkey" FOREIGN KEY ("organization_id", "approval_id") REFERENCES "ai_action_approvals"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "calls" ADD CONSTRAINT "calls_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_session_tenant_fkey" FOREIGN KEY ("organization_id", "channel_session_id") REFERENCES "ai_channel_sessions"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "calls" ADD CONSTRAINT "calls_provider_tenant_fkey" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "calls" ADD CONSTRAINT "calls_customer_tenant_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_tenant_fkey" FOREIGN KEY ("organization_id", "call_id") REFERENCES "calls"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_call_tenant_fkey" FOREIGN KEY ("organization_id", "call_id") REFERENCES "calls"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_consent_event_tenant_fkey" FOREIGN KEY ("organization_id", "consent_event_id") REFERENCES "call_events"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_call_tenant_fkey" FOREIGN KEY ("organization_id", "call_id") REFERENCES "calls"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_event_tenant_fkey" FOREIGN KEY ("organization_id", "call_event_id") REFERENCES "call_events"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "call_summaries" ADD CONSTRAINT "call_summaries_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "call_summaries" ADD CONSTRAINT "call_summaries_call_tenant_fkey" FOREIGN KEY ("organization_id", "call_id") REFERENCES "calls"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "call_summaries" ADD CONSTRAINT "call_summaries_appointment_tenant_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "website_widget_configurations" ADD CONSTRAINT "widget_configuration_origins_nonempty" CHECK (cardinality("allowed_origins") BETWEEN 1 AND 20);
ALTER TABLE "website_widget_configurations" ADD CONSTRAINT "widget_configuration_colors_hex" CHECK ("primary_color" ~ '^#[0-9a-fA-F]{6}$' AND "accent_color" ~ '^#[0-9a-fA-F]{6}$');
ALTER TABLE "website_widget_configurations" ADD CONSTRAINT "widget_configuration_version_positive" CHECK ("version" > 0);
ALTER TABLE "ai_channel_sessions" ADD CONSTRAINT "ai_channel_sessions_external_hash_hex" CHECK ("external_key_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ai_channel_sessions" ADD CONSTRAINT "ai_channel_sessions_expiry_after_creation" CHECK ("expires_at" > "created_at");
ALTER TABLE "ai_channel_sessions" ADD CONSTRAINT "ai_channel_sessions_binding_shape" CHECK (
  ("channel" = 'WEBSITE' AND "widget_configuration_id" IS NOT NULL AND "provider_connection_id" IS NULL AND "origin" IS NOT NULL)
  OR ("channel" IN ('WHATSAPP', 'VOICE') AND "widget_configuration_id" IS NULL AND "provider_connection_id" IS NOT NULL)
);
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_payload_digest_hex" CHECK ("payload_digest" ~ '^[0-9a-f]{64}$');
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_confidence_range" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_stop_after_start" CHECK ("ended_at" IS NULL OR "started_at" IS NULL OR "ended_at" >= "started_at");
ALTER TABLE "calls" ADD CONSTRAINT "calls_end_after_start" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

ALTER TABLE "provider_connections" DROP CONSTRAINT "provider_connections_mock_adapter_check";
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_mock_adapter_check" CHECK ("adapter_key" IN ('MOCK_SMS', 'MOCK_WHATSAPP', 'MOCK_VOICE'));

INSERT INTO "provider_connections" (
  "id", "organization_id", "name", "channel", "adapter_key", "provider_account_id",
  "webhook_secret_reference", "status", "mock_behavior", "created_at", "updated_at"
)
SELECT gen_random_uuid(), organization."id", 'Local mock voice', 'VOICE', 'MOCK_VOICE',
       '+9626' || lpad((abs(hashtextextended(organization."id"::text, 0)) % 10000000)::text, 7, '0'),
       'env:MOCK_VOICE_WEBHOOK_SECRET', 'ACTIVE', 'SUCCESS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organizations" AS organization
WHERE NOT EXISTS (
  SELECT 1 FROM "provider_connections" AS existing
  WHERE existing."organization_id" = organization."id" AND existing."channel" = 'VOICE'
);

WITH template_values ("locale", "body") AS (
  VALUES
    ('en'::"SupportedLocale", 'Hello {{customerName}}, we noticed your missed call. Reply if you would like us to follow up.'),
    ('ar'::"SupportedLocale", 'مرحباً {{customerName}}، لاحظنا مكالمتك الفائتة. رد على هذه الرسالة إذا رغبت بمتابعة الطلب.')
)
INSERT INTO "message_templates" (
  "id", "organization_id", "key", "channel", "locale", "body", "version", "is_active",
  "created_at", "updated_at"
)
SELECT gen_random_uuid(), organization."id", 'MISSED_CALL_RECOVERY', channel."channel",
       template_values."locale", template_values."body", 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organizations" AS organization
CROSS JOIN template_values
CROSS JOIN (VALUES ('SMS'::"CommunicationChannel"), ('WHATSAPP'::"CommunicationChannel")) AS channel("channel")
ON CONFLICT ("organization_id", "key", "channel", "locale", "version") DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON
  "website_widget_configurations", "ai_channel_sessions", "ai_channel_pending_actions", "calls",
  "call_events", "call_recordings", "call_summaries"
TO jormall_app;
GRANT SELECT, INSERT ON "call_transcripts" TO jormall_app;

ALTER TABLE "website_widget_configurations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "website_widget_configurations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "widget_configurations_tenant_isolation" ON "website_widget_configurations" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "ai_channel_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_channel_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_channel_sessions_tenant_isolation" ON "ai_channel_sessions" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "ai_channel_pending_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_channel_pending_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_channel_pending_actions_tenant_isolation" ON "ai_channel_pending_actions" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY "calls_tenant_isolation" ON "calls" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "call_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "call_events_tenant_isolation" ON "call_events" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "call_recordings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_recordings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "call_recordings_tenant_isolation" ON "call_recordings" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "call_transcripts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_transcripts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "call_transcripts_tenant_isolation" ON "call_transcripts" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "call_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_summaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "call_summaries_tenant_isolation" ON "call_summaries" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jormall_channel_router') THEN
    CREATE ROLE jormall_channel_router NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
GRANT jormall_channel_router TO CURRENT_USER;
GRANT SELECT ("id", "organization_id", "public_key", "version", "is_active") ON "website_widget_configurations" TO jormall_channel_router;
CREATE POLICY "widget_configurations_public_routing" ON "website_widget_configurations" FOR SELECT TO jormall_channel_router USING ("is_active" = true);
GRANT SELECT ("id", "organization_id", "channel", "adapter_key", "provider_account_id", "webhook_secret_reference", "status", "mock_behavior") ON "provider_connections" TO jormall_webhook_router;

-- Channel/event records are mutable only for lifecycle state. Payload-bearing evidence cannot be deleted.
CREATE FUNCTION prevent_ai_channel_evidence_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is retained evidence', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "call_events_no_delete" BEFORE DELETE ON "call_events" FOR EACH ROW EXECUTE FUNCTION prevent_ai_channel_evidence_delete();
CREATE TRIGGER "call_recordings_no_delete" BEFORE DELETE ON "call_recordings" FOR EACH ROW EXECUTE FUNCTION prevent_ai_channel_evidence_delete();
CREATE TRIGGER "call_transcripts_no_mutation" BEFORE UPDATE OR DELETE ON "call_transcripts" FOR EACH ROW EXECUTE FUNCTION prevent_ai_channel_evidence_delete();
CREATE TRIGGER "call_summaries_no_delete" BEFORE DELETE ON "call_summaries" FOR EACH ROW EXECUTE FUNCTION prevent_ai_channel_evidence_delete();
