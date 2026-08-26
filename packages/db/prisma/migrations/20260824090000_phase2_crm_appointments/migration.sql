-- Phase 2: tenant-local CRM, consent, appointment operations, and staff reservations.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "CustomerContactKind" AS ENUM ('PHONE', 'EMAIL', 'OTHER');
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'REVOKED');
CREATE TYPE "ConsentChannel" AS ENUM ('STAFF', 'PUBLIC_BOOKING', 'WEBSITE', 'IMPORT', 'API');
CREATE TYPE "ConsentSource" AS ENUM ('STAFF', 'PUBLIC_BOOKING', 'WEBSITE_AI', 'WHATSAPP_AI', 'VOICE_AI', 'IMPORT', 'API');
CREATE TYPE "AppointmentSource" AS ENUM ('PUBLIC_BOOKING', 'STAFF', 'WEBSITE_AI', 'WHATSAPP_AI', 'VOICE_AI', 'IMPORT', 'API');
CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
CREATE TYPE "AppointmentHistoryType" AS ENUM ('CREATED', 'RESCHEDULED', 'STATUS_CHANGED');
CREATE TYPE "AppointmentParticipantType" AS ENUM ('CUSTOMER', 'PROVIDER', 'STAFF');

CREATE TABLE "customers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "display_name" VARCHAR(160) NOT NULL,
  "preferred_locale" "SupportedLocale" NOT NULL DEFAULT 'en',
  "is_archived" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "customers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customers_version_check" CHECK ("version" > 0),
  CONSTRAINT "customers_display_name_check" CHECK (LENGTH(BTRIM("display_name")) > 0)
);

CREATE TABLE "customer_contacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "kind" "CustomerContactKind" NOT NULL DEFAULT 'PHONE',
  "original_value" VARCHAR(320) NOT NULL,
  "normalized_phone_e164" VARCHAR(16),
  "label" VARCHAR(80),
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_contacts_original_value_check" CHECK (LENGTH(BTRIM("original_value")) > 0),
  CONSTRAINT "customer_contacts_jordan_phone_check" CHECK (
    "normalized_phone_e164" IS NULL OR "normalized_phone_e164" ~ '^\\+962[2-9][0-9]{7,8}$'
  )
);

CREATE TABLE "consents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "purpose" VARCHAR(120) NOT NULL,
  "channel" "ConsentChannel" NOT NULL,
  "text_version" VARCHAR(120) NOT NULL,
  "status" "ConsentStatus" NOT NULL,
  "source" "ConsentSource" NOT NULL,
  "evidence" TEXT,
  "actor_user_id" UUID,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokes_consent_id" UUID,
  CONSTRAINT "consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "consents_purpose_check" CHECK (LENGTH(BTRIM("purpose")) > 0),
  CONSTRAINT "consents_version_check" CHECK (LENGTH(BTRIM("text_version")) > 0),
  CONSTRAINT "consents_revocation_check" CHECK (
    ("status" = 'GRANTED' AND "revokes_consent_id" IS NULL)
    OR ("status" = 'REVOKED' AND "revokes_consent_id" IS NOT NULL)
  )
);

CREATE TABLE "appointments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "service_id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "status" "AppointmentStatus" NOT NULL DEFAULT 'PENDING',
  "source" "AppointmentSource" NOT NULL DEFAULT 'STAFF',
  "source_detail" VARCHAR(200),
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "timezone" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "cancelled_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "appointments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointments_time_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "appointments_version_check" CHECK ("version" > 0),
  CONSTRAINT "appointments_timezone_check" CHECK (LENGTH(BTRIM("timezone")) > 0)
);

CREATE TABLE "appointment_staff_reservations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "appointment_id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "appointment_staff_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_staff_reservations_time_check" CHECK ("ends_at" > "starts_at")
);

CREATE TABLE "appointment_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "appointment_id" UUID NOT NULL,
  "summary" TEXT NOT NULL,
  "details" TEXT,
  "authored_by_user_id" UUID NOT NULL,
  "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "appointment_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_records_version_check" CHECK ("version" > 0),
  CONSTRAINT "appointment_records_summary_check" CHECK (LENGTH(BTRIM("summary")) > 0)
);

CREATE TABLE "appointment_status_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "appointment_id" UUID NOT NULL,
  "event_type" "AppointmentHistoryType" NOT NULL,
  "from_status" "AppointmentStatus",
  "to_status" "AppointmentStatus" NOT NULL,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "version" INTEGER NOT NULL,
  "source" "AppointmentSource" NOT NULL,
  "reason" VARCHAR(500),
  "actor_user_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_status_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_status_history_time_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "appointment_status_history_version_check" CHECK ("version" > 0)
);

CREATE TABLE "appointment_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "appointment_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "author_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_notes_body_check" CHECK (LENGTH(BTRIM("body")) > 0)
);

CREATE TABLE "appointment_participants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "appointment_id" UUID NOT NULL,
  "participant_type" "AppointmentParticipantType" NOT NULL,
  "customer_id" UUID,
  "staff_profile_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_participants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_participants_subject_check" CHECK (
    ("participant_type" = 'CUSTOMER' AND "customer_id" IS NOT NULL AND "staff_profile_id" IS NULL)
    OR ("participant_type" IN ('PROVIDER', 'STAFF') AND "customer_id" IS NULL AND "staff_profile_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "customers_organization_id_id_key" ON "customers"("organization_id", "id");
CREATE INDEX "customers_organization_id_display_name_idx" ON "customers"("organization_id", "display_name");
CREATE UNIQUE INDEX "customer_contacts_organization_id_id_key" ON "customer_contacts"("organization_id", "id");
CREATE INDEX "customer_contacts_organization_id_normalized_phone_e164_idx" ON "customer_contacts"("organization_id", "normalized_phone_e164");
CREATE INDEX "customer_contacts_organization_id_customer_id_is_primary_idx" ON "customer_contacts"("organization_id", "customer_id", "is_primary");
CREATE UNIQUE INDEX "customer_contacts_one_primary_per_customer" ON "customer_contacts"("organization_id", "customer_id") WHERE "is_primary";
CREATE UNIQUE INDEX "consents_organization_id_id_key" ON "consents"("organization_id", "id");
CREATE INDEX "consents_organization_id_customer_id_purpose_channel_recorded_at_idx" ON "consents"("organization_id", "customer_id", "purpose", "channel", "recorded_at");
CREATE UNIQUE INDEX "appointments_organization_id_id_key" ON "appointments"("organization_id", "id");
CREATE INDEX "appointments_organization_id_branch_id_starts_at_idx" ON "appointments"("organization_id", "branch_id", "starts_at");
CREATE INDEX "appointments_organization_id_provider_id_starts_at_idx" ON "appointments"("organization_id", "provider_id", "starts_at");
CREATE INDEX "appointments_organization_id_customer_id_starts_at_idx" ON "appointments"("organization_id", "customer_id", "starts_at");
CREATE UNIQUE INDEX "appointment_staff_reservations_appointment_id_key" ON "appointment_staff_reservations"("appointment_id");
CREATE UNIQUE INDEX "appointment_staff_reservations_organization_id_id_key" ON "appointment_staff_reservations"("organization_id", "id");
CREATE UNIQUE INDEX "appointment_staff_reservations_organization_id_appointment_id_key" ON "appointment_staff_reservations"("organization_id", "appointment_id");
CREATE INDEX "appointment_staff_reservations_organization_id_provider_id_starts_at_idx" ON "appointment_staff_reservations"("organization_id", "provider_id", "starts_at");
CREATE UNIQUE INDEX "appointment_records_appointment_id_key" ON "appointment_records"("appointment_id");
CREATE UNIQUE INDEX "appointment_records_organization_id_id_key" ON "appointment_records"("organization_id", "id");
CREATE UNIQUE INDEX "appointment_records_organization_id_appointment_id_key" ON "appointment_records"("organization_id", "appointment_id");
CREATE UNIQUE INDEX "appointment_status_history_organization_id_id_key" ON "appointment_status_history"("organization_id", "id");
CREATE INDEX "appointment_status_history_organization_id_appointment_id_created_at_idx" ON "appointment_status_history"("organization_id", "appointment_id", "created_at");
CREATE UNIQUE INDEX "appointment_notes_organization_id_id_key" ON "appointment_notes"("organization_id", "id");
CREATE INDEX "appointment_notes_organization_id_appointment_id_created_at_idx" ON "appointment_notes"("organization_id", "appointment_id", "created_at");
CREATE UNIQUE INDEX "appointment_participants_organization_id_id_key" ON "appointment_participants"("organization_id", "id");
CREATE UNIQUE INDEX "appointment_participants_organization_id_appointment_id_participant_type_customer_id_staff_profile_id_key" ON "appointment_participants"("organization_id", "appointment_id", "participant_type", "customer_id", "staff_profile_id");
CREATE INDEX "appointment_participants_organization_id_customer_id_idx" ON "appointment_participants"("organization_id", "customer_id");
CREATE INDEX "appointment_participants_organization_id_staff_profile_id_idx" ON "appointment_participants"("organization_id", "staff_profile_id");
CREATE UNIQUE INDEX "appointment_participants_one_customer" ON "appointment_participants"("organization_id", "appointment_id") WHERE "participant_type" = 'CUSTOMER';
CREATE UNIQUE INDEX "appointment_participants_one_provider" ON "appointment_participants"("organization_id", "appointment_id") WHERE "participant_type" = 'PROVIDER';

ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "consents" ADD CONSTRAINT "consents_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consents" ADD CONSTRAINT "consents_organization_id_revokes_consent_id_fkey" FOREIGN KEY ("organization_id", "revokes_consent_id") REFERENCES "consents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consents" ADD CONSTRAINT "consents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "consents" ADD CONSTRAINT "consents_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_service_id_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_provider_id_fkey" FOREIGN KEY ("organization_id", "provider_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_staff_reservations" ADD CONSTRAINT "appointment_staff_reservations_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_staff_reservations" ADD CONSTRAINT "appointment_staff_reservations_organization_id_provider_id_fkey" FOREIGN KEY ("organization_id", "provider_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_staff_reservations" ADD CONSTRAINT "appointment_staff_reservations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_records" ADD CONSTRAINT "appointment_records_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_records" ADD CONSTRAINT "appointment_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_records" ADD CONSTRAINT "appointment_records_authored_by_user_id_fkey" FOREIGN KEY ("authored_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "appointment_notes" ADD CONSTRAINT "appointment_notes_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_notes" ADD CONSTRAINT "appointment_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_notes" ADD CONSTRAINT "appointment_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_organization_id_staff_profile_id_fkey" FOREIGN KEY ("organization_id", "staff_profile_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_staff_reservations"
  ADD CONSTRAINT "appointment_staff_reservations_no_provider_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "provider_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  );

INSERT INTO "permissions" ("id", "code", "name_en", "name_ar") VALUES
  (gen_random_uuid(), 'customers.read', 'Read customers', 'عرض العملاء'),
  (gen_random_uuid(), 'customers.write', 'Manage customers', 'إدارة العملاء'),
  (gen_random_uuid(), 'consent.read', 'Read consent history', 'عرض سجل الموافقات'),
  (gen_random_uuid(), 'consent.record', 'Record consent', 'تسجيل الموافقة'),
  (gen_random_uuid(), 'appointments.read', 'Read appointments', 'عرض المواعيد'),
  (gen_random_uuid(), 'appointments.create', 'Create appointments', 'إنشاء المواعيد'),
  (gen_random_uuid(), 'appointments.reschedule', 'Reschedule appointments', 'إعادة جدولة المواعيد'),
  (gen_random_uuid(), 'appointments.cancel', 'Cancel appointments', 'إلغاء المواعيد'),
  (gen_random_uuid(), 'appointments.status.transition', 'Transition appointment status', 'تحديث حالة الموعد'),
  (gen_random_uuid(), 'appointments.status.correct', 'Correct appointment status', 'تصحيح حالة الموعد'),
  (gen_random_uuid(), 'appointment_records.read', 'Read appointment records', 'عرض سجلات المواعيد'),
  (gen_random_uuid(), 'appointment_records.write', 'Record appointment fulfillment', 'تسجيل تنفيذ الموعد')
ON CONFLICT ("code") DO UPDATE SET "name_en" = EXCLUDED."name_en", "name_ar" = EXCLUDED."name_ar";

WITH role_grants ("role_key", "permission_code", "scope") AS (
  VALUES
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'customers.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'customers.write', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'consent.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'consent.record', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'appointments.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'appointments.create', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'appointments.reschedule', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'appointments.cancel', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'appointments.status.transition', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'appointments.status.correct', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'appointment_records.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'appointment_records.write', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'customers.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'customers.write', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'consent.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'consent.record', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'appointments.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'appointments.create', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'appointments.reschedule', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'appointments.cancel', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'appointments.status.transition', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'appointment_records.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'appointment_records.write', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'customers.read', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'customers.write', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'consent.read', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'consent.record', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'appointments.read', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'appointments.create', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'appointments.reschedule', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'appointments.cancel', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'appointments.status.transition', 'ORGANIZATION'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'appointments.read', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'appointments.reschedule', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'appointments.cancel', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'appointments.status.transition', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'appointment_records.read', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'appointment_records.write', 'SELF'::"PermissionScope")
)
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id", "scope")
SELECT role."organization_id", role."id", permission."id", role_grants."scope"
FROM role_grants
JOIN "roles" AS role ON role."system_key" = role_grants."role_key"
JOIN "permissions" AS permission ON permission."code" = role_grants."permission_code"
ON CONFLICT ("organization_id", "role_id", "permission_id") DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "customers",
  "customer_contacts",
  "appointments",
  "appointment_staff_reservations",
  "appointment_records",
  "appointment_notes",
  "appointment_participants"
TO jormall_app;
GRANT SELECT, INSERT ON "consents", "appointment_status_history" TO jormall_app;

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customers_tenant_isolation" ON "customers"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "customer_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_contacts_tenant_isolation" ON "customer_contacts"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "consents_tenant_isolation" ON "consents"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "appointments_tenant_isolation" ON "appointments"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "appointment_staff_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_staff_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "appointment_staff_reservations_tenant_isolation" ON "appointment_staff_reservations"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "appointment_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "appointment_records_tenant_isolation" ON "appointment_records"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "appointment_status_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_status_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "appointment_status_history_tenant_isolation" ON "appointment_status_history"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "appointment_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "appointment_notes_tenant_isolation" ON "appointment_notes"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "appointment_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "appointment_participants_tenant_isolation" ON "appointment_participants"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

CREATE FUNCTION prevent_phase2_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "consents_immutable"
BEFORE UPDATE OR DELETE ON "consents"
FOR EACH ROW EXECUTE FUNCTION prevent_phase2_append_only_mutation();
CREATE TRIGGER "appointment_status_history_immutable"
BEFORE UPDATE OR DELETE ON "appointment_status_history"
FOR EACH ROW EXECUTE FUNCTION prevent_phase2_append_only_mutation();
