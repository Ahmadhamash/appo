-- Phase 3: resource-aware scheduling, waitlist, and mocked slot offers.
CREATE TYPE "ResourceKind" AS ENUM ('PROVIDER', 'ROOM', 'CHAIR', 'DEVICE', 'VEHICLE', 'SHARED_EQUIPMENT', 'OTHER');
CREATE TYPE "ResourceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');
CREATE TYPE "WaitlistStatus" AS ENUM ('ACTIVE', 'OFFERED', 'FULFILLED', 'CANCELLED');
CREATE TYPE "SlotOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');
CREATE TYPE "SlotOfferAttemptType" AS ENUM ('MOCK_SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED');
CREATE TYPE "SlotOfferAttemptResult" AS ENUM ('SUCCEEDED', 'REJECTED');

CREATE TABLE "branch_hours_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "weekday" "Weekday" NOT NULL,
  "start_minute_local" INTEGER NOT NULL,
  "end_minute_local" INTEGER NOT NULL,
  "effective_from" DATE,
  "effective_until" DATE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branch_hours_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "branch_hours_rules_minutes_check" CHECK (
    "start_minute_local" >= 0 AND "start_minute_local" < "end_minute_local" AND "end_minute_local" <= 1440
  ),
  CONSTRAINT "branch_hours_rules_effective_check" CHECK (
    "effective_until" IS NULL OR "effective_from" IS NULL OR "effective_until" >= "effective_from"
  )
);

CREATE TABLE "resource_groups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "name_en" VARCHAR(160) NOT NULL,
  "name_ar" VARCHAR(160) NOT NULL,
  "kind" "ResourceKind" NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resource_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_groups_names_check" CHECK (
    LENGTH(BTRIM("name_en")) > 0 AND LENGTH(BTRIM("name_ar")) > 0
  )
);

CREATE TABLE "resources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "group_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "staff_profile_id" UUID,
  "name_en" VARCHAR(160) NOT NULL,
  "name_ar" VARCHAR(160) NOT NULL,
  "status" "ResourceStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resources_names_check" CHECK (
    LENGTH(BTRIM("name_en")) > 0 AND LENGTH(BTRIM("name_ar")) > 0
  )
);

CREATE TABLE "resource_availability_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "resource_id" UUID NOT NULL,
  "weekday" "Weekday" NOT NULL,
  "start_minute_local" INTEGER NOT NULL,
  "end_minute_local" INTEGER NOT NULL,
  "effective_from" DATE,
  "effective_until" DATE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resource_availability_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_availability_rules_minutes_check" CHECK (
    "start_minute_local" >= 0 AND "start_minute_local" < "end_minute_local" AND "end_minute_local" <= 1440
  ),
  CONSTRAINT "resource_availability_rules_effective_check" CHECK (
    "effective_until" IS NULL OR "effective_from" IS NULL OR "effective_until" >= "effective_from"
  )
);

CREATE TABLE "service_resource_requirements" (
  "organization_id" UUID NOT NULL,
  "service_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "resource_group_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_resource_requirements_pkey" PRIMARY KEY (
    "organization_id", "service_id", "branch_id", "resource_group_id"
  ),
  CONSTRAINT "service_resource_requirements_quantity_check" CHECK ("quantity" BETWEEN 1 AND 20)
);

CREATE TABLE "appointment_resources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "appointment_id" UUID NOT NULL,
  "resource_id" UUID NOT NULL,
  "resource_group_id" UUID NOT NULL,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_resources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_resources_time_check" CHECK ("ends_at" > "starts_at")
);

CREATE TABLE "waitlist_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "service_id" UUID NOT NULL,
  "appointment_id" UUID,
  "preferred_start_date" DATE NOT NULL,
  "preferred_end_date" DATE NOT NULL,
  "preferred_start_minute" INTEGER NOT NULL DEFAULT 0,
  "preferred_end_minute" INTEGER NOT NULL DEFAULT 1440,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "notes" VARCHAR(500),
  "status" "WaitlistStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "waitlist_entries_dates_check" CHECK ("preferred_end_date" >= "preferred_start_date"),
  CONSTRAINT "waitlist_entries_minutes_check" CHECK (
    "preferred_start_minute" >= 0 AND "preferred_start_minute" < "preferred_end_minute" AND "preferred_end_minute" <= 1440
  ),
  CONSTRAINT "waitlist_entries_priority_check" CHECK ("priority" BETWEEN -100 AND 100),
  CONSTRAINT "waitlist_entries_version_check" CHECK ("version" > 0)
);

CREATE TABLE "waitlist_entry_branches" (
  "organization_id" UUID NOT NULL,
  "waitlist_entry_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "waitlist_entry_branches_pkey" PRIMARY KEY ("organization_id", "waitlist_entry_id", "branch_id")
);

CREATE TABLE "waitlist_entry_providers" (
  "organization_id" UUID NOT NULL,
  "waitlist_entry_id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "waitlist_entry_providers_pkey" PRIMARY KEY ("organization_id", "waitlist_entry_id", "provider_id")
);

CREATE TABLE "slot_offers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "waitlist_entry_id" UUID NOT NULL,
  "target_appointment_id" UUID,
  "target_appointment_version" INTEGER,
  "branch_id" UUID NOT NULL,
  "service_id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "timezone" VARCHAR(100) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "status" "SlotOfferStatus" NOT NULL DEFAULT 'PENDING',
  "accepted_request_key" UUID,
  "accepted_fingerprint" CHAR(64),
  "accepted_appointment_id" UUID,
  "accepted_at" TIMESTAMPTZ(3),
  "declined_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "slot_offers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "slot_offers_time_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "slot_offers_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "slot_offers_version_check" CHECK ("version" > 0),
  CONSTRAINT "slot_offers_target_version_check" CHECK (
    ("target_appointment_id" IS NULL AND "target_appointment_version" IS NULL)
    OR ("target_appointment_id" IS NOT NULL AND "target_appointment_version" IS NOT NULL)
  ),
  CONSTRAINT "slot_offers_acceptance_check" CHECK (
    ("status" = 'ACCEPTED' AND "accepted_request_key" IS NOT NULL AND "accepted_fingerprint" IS NOT NULL AND "accepted_appointment_id" IS NOT NULL AND "accepted_at" IS NOT NULL)
    OR ("status" <> 'ACCEPTED' AND "accepted_at" IS NULL)
  )
);

CREATE TABLE "slot_offer_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "slot_offer_id" UUID NOT NULL,
  "attempt_type" "SlotOfferAttemptType" NOT NULL,
  "result" "SlotOfferAttemptResult" NOT NULL,
  "request_key" UUID,
  "request_fingerprint" CHAR(64),
  "reason" VARCHAR(500),
  "actor_user_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "slot_offer_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branch_hours_rules_organization_id_id_key" ON "branch_hours_rules"("organization_id", "id");
CREATE INDEX "branch_hours_rules_organization_id_branch_id_weekday_idx" ON "branch_hours_rules"("organization_id", "branch_id", "weekday");
CREATE UNIQUE INDEX "resource_groups_organization_id_id_key" ON "resource_groups"("organization_id", "id");
CREATE INDEX "resource_groups_organization_id_branch_id_is_active_idx" ON "resource_groups"("organization_id", "branch_id", "is_active");
CREATE UNIQUE INDEX "resources_organization_id_id_key" ON "resources"("organization_id", "id");
CREATE UNIQUE INDEX "resources_organization_id_staff_profile_id_key" ON "resources"("organization_id", "staff_profile_id");
CREATE INDEX "resources_organization_id_group_id_status_idx" ON "resources"("organization_id", "group_id", "status");
CREATE INDEX "resources_organization_id_branch_id_status_idx" ON "resources"("organization_id", "branch_id", "status");
CREATE UNIQUE INDEX "resource_availability_rules_organization_id_id_key" ON "resource_availability_rules"("organization_id", "id");
CREATE INDEX "resource_availability_rules_organization_id_resource_id_wee_idx" ON "resource_availability_rules"("organization_id", "resource_id", "weekday");
CREATE INDEX "service_resource_requirements_organization_id_branch_id_res_idx" ON "service_resource_requirements"("organization_id", "branch_id", "resource_group_id");
CREATE UNIQUE INDEX "appointment_resources_organization_id_id_key" ON "appointment_resources"("organization_id", "id");
CREATE UNIQUE INDEX "appointment_resources_organization_id_appointment_id_resour_key" ON "appointment_resources"("organization_id", "appointment_id", "resource_id");
CREATE INDEX "appointment_resources_organization_id_resource_id_starts_at_idx" ON "appointment_resources"("organization_id", "resource_id", "starts_at");
CREATE INDEX "appointment_resources_organization_id_appointment_id_idx" ON "appointment_resources"("organization_id", "appointment_id");
CREATE UNIQUE INDEX "waitlist_entries_organization_id_id_key" ON "waitlist_entries"("organization_id", "id");
CREATE UNIQUE INDEX "waitlist_entries_organization_id_appointment_id_key" ON "waitlist_entries"("organization_id", "appointment_id");
CREATE INDEX "waitlist_entries_organization_id_status_priority_created_at_idx" ON "waitlist_entries"("organization_id", "status", "priority", "created_at");
CREATE INDEX "waitlist_entries_organization_id_customer_id_idx" ON "waitlist_entries"("organization_id", "customer_id");
CREATE UNIQUE INDEX "slot_offers_organization_id_id_key" ON "slot_offers"("organization_id", "id");
CREATE INDEX "slot_offers_organization_id_status_expires_at_idx" ON "slot_offers"("organization_id", "status", "expires_at");
CREATE INDEX "slot_offers_organization_id_waitlist_entry_id_created_at_idx" ON "slot_offers"("organization_id", "waitlist_entry_id", "created_at");
CREATE UNIQUE INDEX "slot_offer_attempts_organization_id_id_key" ON "slot_offer_attempts"("organization_id", "id");
CREATE UNIQUE INDEX "slot_offer_attempts_organization_id_slot_offer_id_attempt_t_key" ON "slot_offer_attempts"("organization_id", "slot_offer_id", "attempt_type", "request_key");
CREATE INDEX "slot_offer_attempts_organization_id_slot_offer_id_created_a_idx" ON "slot_offer_attempts"("organization_id", "slot_offer_id", "created_at");

ALTER TABLE "branch_hours_rules" ADD CONSTRAINT "branch_hours_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_hours_rules" ADD CONSTRAINT "branch_hours_rules_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resource_groups" ADD CONSTRAINT "resource_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resource_groups" ADD CONSTRAINT "resource_groups_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "resources" ADD CONSTRAINT "resources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resources" ADD CONSTRAINT "resources_organization_id_group_id_fkey" FOREIGN KEY ("organization_id", "group_id") REFERENCES "resource_groups"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "resources" ADD CONSTRAINT "resources_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "resources" ADD CONSTRAINT "resources_organization_id_staff_profile_id_fkey" FOREIGN KEY ("organization_id", "staff_profile_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "resource_availability_rules" ADD CONSTRAINT "resource_availability_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resource_availability_rules" ADD CONSTRAINT "resource_availability_rules_organization_id_resource_id_fkey" FOREIGN KEY ("organization_id", "resource_id") REFERENCES "resources"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_resource_requirements" ADD CONSTRAINT "service_resource_requirements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_resource_requirements" ADD CONSTRAINT "service_resource_requirements_organization_id_service_id_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_resource_requirements" ADD CONSTRAINT "service_resource_requirements_organization_id_service_id_b_fkey" FOREIGN KEY ("organization_id", "service_id", "branch_id") REFERENCES "service_branches"("organization_id", "service_id", "branch_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_resource_requirements" ADD CONSTRAINT "service_resource_requirements_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_resource_requirements" ADD CONSTRAINT "service_resource_requirements_organization_id_resource_gro_fkey" FOREIGN KEY ("organization_id", "resource_group_id") REFERENCES "resource_groups"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_resources" ADD CONSTRAINT "appointment_resources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_resources" ADD CONSTRAINT "appointment_resources_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_resources" ADD CONSTRAINT "appointment_resources_organization_id_resource_id_fkey" FOREIGN KEY ("organization_id", "resource_id") REFERENCES "resources"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_resources" ADD CONSTRAINT "appointment_resources_organization_id_resource_group_id_fkey" FOREIGN KEY ("organization_id", "resource_group_id") REFERENCES "resource_groups"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_organization_id_service_id_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "waitlist_entry_branches" ADD CONSTRAINT "waitlist_entry_branches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entry_branches" ADD CONSTRAINT "waitlist_entry_branches_organization_id_waitlist_entry_id_fkey" FOREIGN KEY ("organization_id", "waitlist_entry_id") REFERENCES "waitlist_entries"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entry_branches" ADD CONSTRAINT "waitlist_entry_branches_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "waitlist_entry_providers" ADD CONSTRAINT "waitlist_entry_providers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entry_providers" ADD CONSTRAINT "waitlist_entry_providers_organization_id_waitlist_entry_id_fkey" FOREIGN KEY ("organization_id", "waitlist_entry_id") REFERENCES "waitlist_entries"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entry_providers" ADD CONSTRAINT "waitlist_entry_providers_organization_id_provider_id_fkey" FOREIGN KEY ("organization_id", "provider_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_organization_id_waitlist_entry_id_fkey" FOREIGN KEY ("organization_id", "waitlist_entry_id") REFERENCES "waitlist_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_organization_id_target_appointment_id_fkey" FOREIGN KEY ("organization_id", "target_appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_organization_id_accepted_appointment_id_fkey" FOREIGN KEY ("organization_id", "accepted_appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_organization_id_service_id_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_organization_id_provider_id_fkey" FOREIGN KEY ("organization_id", "provider_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slot_offer_attempts" ADD CONSTRAINT "slot_offer_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slot_offer_attempts" ADD CONSTRAINT "slot_offer_attempts_organization_id_slot_offer_id_fkey" FOREIGN KEY ("organization_id", "slot_offer_id") REFERENCES "slot_offers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slot_offer_attempts" ADD CONSTRAINT "slot_offer_attempts_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "appointment_resources"
  ADD CONSTRAINT "appointment_resources_no_resource_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "resource_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  );

-- Existing upgraded branches remain operational until their owner narrows these defaults.
INSERT INTO "branch_hours_rules" (
  "organization_id", "branch_id", "weekday", "start_minute_local", "end_minute_local"
)
SELECT branch."organization_id", branch."id", weekday, 0, 1440
FROM "branches" AS branch
CROSS JOIN unnest(enum_range(NULL::"Weekday")) AS weekday;

INSERT INTO "permissions" ("id", "code", "name_en", "name_ar") VALUES
  (gen_random_uuid(), 'appointments.availability.read', 'Find available appointment slots', 'البحث عن المواعيد المتاحة'),
  (gen_random_uuid(), 'resources.read', 'Read scheduling resources', 'عرض موارد الجدولة'),
  (gen_random_uuid(), 'resources.manage', 'Manage scheduling resources', 'إدارة موارد الجدولة'),
  (gen_random_uuid(), 'waitlist.read', 'Read waitlist', 'عرض قائمة الانتظار'),
  (gen_random_uuid(), 'waitlist.manage', 'Manage waitlist', 'إدارة قائمة الانتظار'),
  (gen_random_uuid(), 'slot_offers.manage', 'Manage mocked slot offers', 'إدارة عروض المواعيد التجريبية')
ON CONFLICT ("code") DO UPDATE SET "name_en" = EXCLUDED."name_en", "name_ar" = EXCLUDED."name_ar";

WITH role_grants ("role_key", "permission_code", "scope") AS (
  VALUES
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'appointments.availability.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'resources.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'resources.manage', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'waitlist.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'waitlist.manage', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_OWNER'::"TenantRoleKey", 'slot_offers.manage', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'appointments.availability.read', 'ASSIGNED_BRANCHES'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'resources.read', 'ASSIGNED_BRANCHES'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'resources.manage', 'ASSIGNED_BRANCHES'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'waitlist.read', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'waitlist.manage', 'ORGANIZATION'::"PermissionScope"),
    ('ORGANIZATION_MANAGER'::"TenantRoleKey", 'slot_offers.manage', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'appointments.availability.read', 'ASSIGNED_BRANCHES'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'resources.read', 'ASSIGNED_BRANCHES'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'waitlist.read', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'waitlist.manage', 'ORGANIZATION'::"PermissionScope"),
    ('SECRETARY'::"TenantRoleKey", 'slot_offers.manage', 'ORGANIZATION'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'appointments.availability.read', 'SELF'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'resources.read', 'ASSIGNED_BRANCHES'::"PermissionScope"),
    ('PROVIDER'::"TenantRoleKey", 'waitlist.read', 'SELF'::"PermissionScope")
)
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id", "scope")
SELECT role."organization_id", role."id", permission."id", role_grants."scope"
FROM role_grants
JOIN "roles" AS role ON role."system_key" = role_grants."role_key"
JOIN "permissions" AS permission ON permission."code" = role_grants."permission_code"
ON CONFLICT ("organization_id", "role_id", "permission_id") DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "branch_hours_rules", "resource_groups", "resources", "resource_availability_rules",
  "service_resource_requirements", "appointment_resources", "waitlist_entries",
  "waitlist_entry_branches", "waitlist_entry_providers", "slot_offers"
TO jormall_app;
GRANT SELECT, INSERT ON "slot_offer_attempts" TO jormall_app;

ALTER TABLE "branch_hours_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branch_hours_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "branch_hours_rules_tenant_isolation" ON "branch_hours_rules" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "resource_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "resource_groups_tenant_isolation" ON "resource_groups" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "resources_tenant_isolation" ON "resources" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "resource_availability_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_availability_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "resource_availability_rules_tenant_isolation" ON "resource_availability_rules" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "service_resource_requirements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_resource_requirements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_resource_requirements_tenant_isolation" ON "service_resource_requirements" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "appointment_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_resources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "appointment_resources_tenant_isolation" ON "appointment_resources" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waitlist_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "waitlist_entries_tenant_isolation" ON "waitlist_entries" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "waitlist_entry_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waitlist_entry_branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "waitlist_entry_branches_tenant_isolation" ON "waitlist_entry_branches" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "waitlist_entry_providers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waitlist_entry_providers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "waitlist_entry_providers_tenant_isolation" ON "waitlist_entry_providers" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "slot_offers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slot_offers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "slot_offers_tenant_isolation" ON "slot_offers" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
ALTER TABLE "slot_offer_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slot_offer_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "slot_offer_attempts_tenant_isolation" ON "slot_offer_attempts" USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

CREATE FUNCTION prevent_slot_offer_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "slot_offer_attempts_immutable"
BEFORE UPDATE OR DELETE ON "slot_offer_attempts"
FOR EACH ROW EXECUTE FUNCTION prevent_slot_offer_attempt_mutation();
