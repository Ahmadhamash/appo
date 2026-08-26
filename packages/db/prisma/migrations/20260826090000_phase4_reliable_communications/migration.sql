-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('SMS', 'WHATSAPP', 'EMAIL', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND', 'INTERNAL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "MessageAttemptStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'CLAIMED', 'ENQUEUED', 'PROCESSED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "InboxEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "ProviderConnectionStatus" AS ENUM ('ACTIVE', 'DISABLED', 'MISCONFIGURED');

-- CreateEnum
CREATE TYPE "MockProviderBehavior" AS ENUM ('SUCCESS', 'TRANSIENT_ONCE', 'TIMEOUT', 'PERMANENT_FAILURE');

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "appointment_id" UUID,
    "channel" "CommunicationChannel" NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "subject" VARCHAR(200),
    "last_message_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "locale" "SupportedLocale" NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "adapter_key" VARCHAR(80) NOT NULL,
    "provider_account_id" VARCHAR(160),
    "webhook_secret_reference" VARCHAR(200),
    "status" "ProviderConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "mock_behavior" "MockProviderBehavior" NOT NULL DEFAULT 'SUCCESS',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "changed_by_user_id" UUID,
    "reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "communication_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "appointment_id" UUID,
    "template_id" UUID,
    "provider_connection_id" UUID,
    "created_by_user_id" UUID,
    "channel" "CommunicationChannel" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "locale" "SupportedLocale" NOT NULL,
    "body" TEXT NOT NULL,
    "consent_purpose" VARCHAR(120),
    "consent_id" UUID,
    "provider_message_id" VARCHAR(200),
    "last_error_code" VARCHAR(100),
    "last_error_category" VARCHAR(80),
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "provider_connection_id" UUID,
    "attempt_number" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "status" "MessageAttemptStatus" NOT NULL,
    "provider_message_id" VARCHAR(200),
    "error_code" VARCHAR(100),
    "error_category" VARCHAR(80),
    "safe_error_message" VARCHAR(300),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "next_retry_at" TIMESTAMPTZ(3),

    CONSTRAINT "message_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "aggregate_type" VARCHAR(80) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "deduplication_key" VARCHAR(220) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(3),
    "claimed_by" VARCHAR(120),
    "enqueued_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),
    "dead_letter_at" TIMESTAMPTZ(3),
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(100),
    "last_error_category" VARCHAR(80),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_connection_id" UUID NOT NULL,
    "provider_event_id" VARCHAR(200) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "payload_digest" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "InboxEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "error_code" VARCHAR(100),

    CONSTRAINT "inbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "provider_connection_id" UUID NOT NULL,
    "inbox_event_id" UUID,
    "provider_message_id" VARCHAR(200) NOT NULL,
    "state" "DeliveryState" NOT NULL,
    "provider_timestamp" TIMESTAMPTZ(3) NOT NULL,
    "normalized_error_code" VARCHAR(100),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "worker_id" VARCHAR(120) NOT NULL,
    "queue_name" VARCHAR(120) NOT NULL,
    "status" VARCHAR(40) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "last_processed_at" TIMESTAMPTZ(3),
    "application_version" VARCHAR(80) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("worker_id")
);

-- CreateIndex
CREATE INDEX "conversations_organization_id_status_last_message_at_idx" ON "conversations"("organization_id", "status", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_organization_id_customer_id_last_message_at_idx" ON "conversations"("organization_id", "customer_id", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_organization_id_appointment_id_last_message_a_idx" ON "conversations"("organization_id", "appointment_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_id_key" ON "conversations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "message_templates_organization_id_key_channel_locale_is_act_idx" ON "message_templates"("organization_id", "key", "channel", "locale", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_organization_id_id_key" ON "message_templates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_organization_id_key_channel_locale_versio_key" ON "message_templates"("organization_id", "key", "channel", "locale", "version");

-- CreateIndex
CREATE INDEX "provider_connections_organization_id_channel_status_idx" ON "provider_connections"("organization_id", "channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "provider_connections_organization_id_id_key" ON "provider_connections"("organization_id", "id");

-- CreateIndex
CREATE INDEX "communication_preferences_organization_id_customer_id_idx" ON "communication_preferences"("organization_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "communication_preferences_organization_id_id_key" ON "communication_preferences"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "communication_preferences_organization_id_customer_id_chann_key" ON "communication_preferences"("organization_id", "customer_id", "channel");

-- CreateIndex
CREATE INDEX "messages_organization_id_conversation_id_created_at_idx" ON "messages"("organization_id", "conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_organization_id_customer_id_created_at_idx" ON "messages"("organization_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_organization_id_appointment_id_created_at_idx" ON "messages"("organization_id", "appointment_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_organization_id_status_created_at_idx" ON "messages"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_organization_id_id_key" ON "messages"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_organization_id_provider_connection_id_provider_me_key" ON "messages"("organization_id", "provider_connection_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "message_attempts_organization_id_message_id_started_at_idx" ON "message_attempts"("organization_id", "message_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_attempts_organization_id_id_key" ON "message_attempts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_attempts_organization_id_message_id_attempt_number_key" ON "message_attempts"("organization_id", "message_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "message_attempts_organization_id_idempotency_key_key" ON "message_attempts"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_created_at_idx" ON "outbox_events"("status", "available_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_organization_id_aggregate_type_aggregate_id_idx" ON "outbox_events"("organization_id", "aggregate_type", "aggregate_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_organization_id_id_key" ON "outbox_events"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_organization_id_deduplication_key_key" ON "outbox_events"("organization_id", "deduplication_key");

-- CreateIndex
CREATE INDEX "inbox_events_organization_id_status_received_at_idx" ON "inbox_events"("organization_id", "status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_events_organization_id_id_key" ON "inbox_events"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_events_provider_connection_id_provider_event_id_key" ON "inbox_events"("provider_connection_id", "provider_event_id");

-- CreateIndex
CREATE INDEX "delivery_receipts_organization_id_message_id_provider_times_idx" ON "delivery_receipts"("organization_id", "message_id", "provider_timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_receipts_organization_id_id_key" ON "delivery_receipts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_receipts_organization_id_inbox_event_id_key" ON "delivery_receipts"("organization_id", "inbox_event_id");

-- CreateIndex
CREATE INDEX "worker_heartbeats_queue_name_last_seen_at_idx" ON "worker_heartbeats"("queue_name", "last_seen_at");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_preferences" ADD CONSTRAINT "communication_preferences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_preferences" ADD CONSTRAINT "communication_preferences_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "message_templates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_provider_connection_id_fkey" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "messages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_organization_id_provider_connection_id_fkey" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_events" ADD CONSTRAINT "inbox_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_events" ADD CONSTRAINT "inbox_events_organization_id_provider_connection_id_fkey" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "messages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_organization_id_provider_connection_id_fkey" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_organization_id_inbox_event_id_fkey" FOREIGN KEY ("organization_id", "inbox_event_id") REFERENCES "inbox_events"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 4 permissions are registered in code and mirrored into every tenant's protected roles.
INSERT INTO "permissions" ("id", "code", "name_en", "name_ar") VALUES
  (gen_random_uuid(), 'messages.read', 'Read communications', 'عرض الاتصالات'),
  (gen_random_uuid(), 'messages.send', 'Send communications', 'إرسال الاتصالات'),
  (gen_random_uuid(), 'messages.retry', 'Retry failed communications', 'إعادة محاولة الاتصالات الفاشلة'),
  (gen_random_uuid(), 'message_templates.manage', 'Manage message templates', 'إدارة قوالب الرسائل'),
  (gen_random_uuid(), 'communication_preferences.manage', 'Manage communication preferences', 'إدارة تفضيلات الاتصال'),
  (gen_random_uuid(), 'provider_credentials.manage', 'Manage provider connections', 'إدارة اتصالات مزودي الخدمة')
ON CONFLICT ("code") DO UPDATE SET "name_en" = EXCLUDED."name_en", "name_ar" = EXCLUDED."name_ar";

WITH role_grants ("role_key", "permission_code", "scope") AS (
  VALUES
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'messages.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'messages.send', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'messages.retry', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'message_templates.manage', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'communication_preferences.manage', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'provider_credentials.manage', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'messages.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'messages.send', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'messages.retry', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'communication_preferences.manage', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'messages.read', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'messages.send', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'messages.retry', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'communication_preferences.manage', 'ORGANIZATION'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'messages.read', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'messages.send', 'SELF'::"PermissionScope")
)
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id", "scope")
SELECT role."organization_id", role."id", permission."id", role_grants."scope"
FROM role_grants
JOIN "roles" AS role ON role."system_key" = role_grants."role_key"
JOIN "permissions" AS permission ON permission."code" = role_grants."permission_code"
ON CONFLICT ("organization_id", "role_id", "permission_id") DO NOTHING;

-- Local adapters are deliberately non-production and store only an environment variable reference.
INSERT INTO "provider_connections" (
  "id", "organization_id", "name", "channel", "adapter_key", "webhook_secret_reference",
  "status", "mock_behavior", "created_at", "updated_at"
)
SELECT gen_random_uuid(), organization."id", 'Local mock WhatsApp', 'WHATSAPP', 'MOCK_WHATSAPP',
       'env:MOCK_WHATSAPP_WEBHOOK_SECRET', 'ACTIVE', 'SUCCESS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organizations" AS organization;

INSERT INTO "provider_connections" (
  "id", "organization_id", "name", "channel", "adapter_key", "status", "mock_behavior",
  "created_at", "updated_at"
)
SELECT gen_random_uuid(), organization."id", 'Local mock SMS', 'SMS', 'MOCK_SMS',
       'ACTIVE', 'SUCCESS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organizations" AS organization;

WITH template_values ("key", "locale", "body") AS (
  VALUES
    ('APPOINTMENT_CONFIRMATION', 'en'::"SupportedLocale", 'Hello {{customerName}}, your {{serviceName}} appointment is confirmed for {{startsAt}}.'),
    ('APPOINTMENT_CONFIRMATION', 'ar'::"SupportedLocale", 'مرحباً {{customerName}}، تم تأكيد موعد {{serviceName}} بتاريخ {{startsAt}}.'),
    ('APPOINTMENT_REMINDER', 'en'::"SupportedLocale", 'Reminder: your {{serviceName}} appointment is at {{startsAt}}.'),
    ('APPOINTMENT_REMINDER', 'ar'::"SupportedLocale", 'تذكير: موعد {{serviceName}} الخاص بك بتاريخ {{startsAt}}.'),
    ('APPOINTMENT_CANCELLATION', 'en'::"SupportedLocale", 'Your {{serviceName}} appointment at {{startsAt}} has been cancelled.'),
    ('APPOINTMENT_CANCELLATION', 'ar'::"SupportedLocale", 'تم إلغاء موعد {{serviceName}} بتاريخ {{startsAt}}.'),
    ('SLOT_OFFER', 'en'::"SupportedLocale", 'A {{serviceName}} slot is available at {{startsAt}}. Contact the organization to accept.'),
    ('SLOT_OFFER', 'ar'::"SupportedLocale", 'يتوفر موعد لخدمة {{serviceName}} بتاريخ {{startsAt}}. تواصل مع المؤسسة للقبول.')
)
INSERT INTO "message_templates" (
  "id", "organization_id", "key", "channel", "locale", "body", "version", "is_active",
  "created_at", "updated_at"
)
SELECT gen_random_uuid(), organization."id", template_values."key", channel."channel",
       template_values."locale", template_values."body", 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organizations" AS organization
CROSS JOIN template_values
CROSS JOIN (VALUES ('SMS'::"CommunicationChannel"), ('WHATSAPP'::"CommunicationChannel")) AS channel("channel");

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "conversations", "message_templates", "provider_connections", "communication_preferences", "messages"
TO jormall_app;
GRANT SELECT, INSERT ON "message_attempts", "delivery_receipts" TO jormall_app;
GRANT SELECT, INSERT, UPDATE ON "outbox_events", "inbox_events" TO jormall_app;

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "conversations_tenant_isolation" ON "conversations" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "message_templates_tenant_isolation" ON "message_templates" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "provider_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_connections_tenant_isolation" ON "provider_connections" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "communication_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "communication_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "communication_preferences_tenant_isolation" ON "communication_preferences" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "messages_tenant_isolation" ON "messages" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "message_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "message_attempts_tenant_isolation" ON "message_attempts" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_events_tenant_isolation" ON "outbox_events" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "inbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inbox_events_tenant_isolation" ON "inbox_events" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "delivery_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "delivery_receipts_tenant_isolation" ON "delivery_receipts" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

-- Narrow infrastructure roles can route verified webhooks and relay outbox IDs without tenant data access.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jormall_relay') THEN
    CREATE ROLE jormall_relay NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jormall_webhook_router') THEN
    CREATE ROLE jormall_webhook_router NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
GRANT jormall_relay, jormall_webhook_router TO CURRENT_USER;
GRANT SELECT, UPDATE ON "outbox_events" TO jormall_relay;
GRANT SELECT ("id", "organization_id", "channel", "adapter_key", "webhook_secret_reference", "status")
  ON "provider_connections" TO jormall_webhook_router;
CREATE POLICY "outbox_events_relay_access" ON "outbox_events" TO jormall_relay USING (true) WITH CHECK (true);
CREATE POLICY "provider_connections_webhook_routing" ON "provider_connections" FOR SELECT TO jormall_webhook_router USING (true);

CREATE FUNCTION prevent_communication_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "message_attempts_immutable"
BEFORE UPDATE OR DELETE ON "message_attempts"
FOR EACH ROW EXECUTE FUNCTION prevent_communication_evidence_mutation();
CREATE TRIGGER "delivery_receipts_immutable"
BEFORE UPDATE OR DELETE ON "delivery_receipts"
FOR EACH ROW EXECUTE FUNCTION prevent_communication_evidence_mutation();

ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_mock_adapter_check"
  CHECK ("adapter_key" IN ('MOCK_SMS', 'MOCK_WHATSAPP'));
ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_secret_reference_check"
  CHECK ("webhook_secret_reference" IS NULL OR "webhook_secret_reference" LIKE 'env:%');
