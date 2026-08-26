-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- UUID generation and the least-privilege runtime role are database-owned.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jormall_app') THEN
    CREATE ROLE jormall_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'JORMALL_SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "TenantRoleKey" AS ENUM ('ORGANIZATION_OWNER', 'ORGANIZATION_MANAGER', 'SECRETARY', 'PROVIDER');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('ORGANIZATION', 'ASSIGNED_BRANCHES', 'SELF');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SupportedLocale" AS ENUM ('en', 'ar');

-- CreateEnum
CREATE TYPE "Weekday" AS ENUM ('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(160) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "platform_role" "PlatformRole" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "ip_address" VARCHAR(64),
    "user_agent" TEXT,
    "user_id" UUID NOT NULL,
    "active_organization_id" UUID,
    "active_membership_id" UUID,
    "active_support_access_id" UUID,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" VARCHAR(255) NOT NULL,
    "provider_id" VARCHAR(100) NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identifier" VARCHAR(320) NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(255) NOT NULL,
    "count" INTEGER NOT NULL,
    "last_request" BIGINT NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rate_limits_key_key" ON "rate_limits"("key");

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(80) NOT NULL,
    "name_en" VARCHAR(160) NOT NULL,
    "name_ar" VARCHAR(160) NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'PENDING',
    "created_by_user_id" UUID NOT NULL,
    "suspended_at" TIMESTAMPTZ(3),
    "suspension_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "default_locale" "SupportedLocale" NOT NULL DEFAULT 'en',
    "timezone" VARCHAR(100) NOT NULL DEFAULT 'Asia/Amman',
    "currency" CHAR(3) NOT NULL DEFAULT 'JOD',
    "booking_window_days" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name_en" VARCHAR(160) NOT NULL,
    "name_ar" VARCHAR(160) NOT NULL,
    "timezone" VARCHAR(100) NOT NULL DEFAULT 'Asia/Amman',
    "phone" VARCHAR(40),
    "address_en" VARCHAR(500),
    "address_ar" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "system_key" "TenantRoleKey",
    "name_en" VARCHAR(120) NOT NULL,
    "name_ar" VARCHAR(120) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(120) NOT NULL,
    "name_en" VARCHAR(160) NOT NULL,
    "name_ar" VARCHAR(160) NOT NULL,
    "description" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "organization_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "scope" "PermissionScope" NOT NULL DEFAULT 'ORGANIZATION',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("organization_id","role_id","permission_id")
);

-- CreateTable
CREATE TABLE "membership_roles" (
    "organization_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_roles_pkey" PRIMARY KEY ("organization_id","membership_id","role_id")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "display_name_en" VARCHAR(160) NOT NULL,
    "display_name_ar" VARCHAR(160) NOT NULL,
    "bio_en" TEXT,
    "bio_ar" TEXT,
    "is_bookable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_branch_assignments" (
    "organization_id" UUID NOT NULL,
    "staff_profile_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_branch_assignments_pkey" PRIMARY KEY ("organization_id","staff_profile_id","branch_id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name_en" VARCHAR(160) NOT NULL,
    "name_ar" VARCHAR(160) NOT NULL,
    "description_en" TEXT,
    "description_ar" TEXT,
    "default_duration_mins" INTEGER NOT NULL,
    "default_price_minor" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'JOD',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_branches" (
    "organization_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "price_minor" INTEGER,
    "duration_mins" INTEGER,
    "buffer_before_mins" INTEGER NOT NULL DEFAULT 0,
    "buffer_after_mins" INTEGER NOT NULL DEFAULT 0,
    "booking_window_days" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_branches_pkey" PRIMARY KEY ("organization_id","service_id","branch_id")
);

-- CreateTable
CREATE TABLE "staff_services" (
    "organization_id" UUID NOT NULL,
    "staff_profile_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_services_pkey" PRIMARY KEY ("organization_id","staff_profile_id","service_id")
);

-- CreateTable
CREATE TABLE "availability_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "staff_profile_id" UUID NOT NULL,
    "branch_id" UUID,
    "weekday" "Weekday" NOT NULL,
    "start_minute_local" INTEGER NOT NULL,
    "end_minute_local" INTEGER NOT NULL,
    "effective_from" DATE,
    "effective_until" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "staff_profile_id" UUID NOT NULL,
    "branch_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invited_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_support_accesses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "permission_codes" TEXT[],
    "starts_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_support_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "support_access_id" UUID,
    "action" VARCHAR(120) NOT NULL,
    "target_type" VARCHAR(100),
    "target_id" UUID,
    "reason" VARCHAR(500),
    "metadata" JSONB,
    "ip_address" VARCHAR(64),
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organization_settings_organization_id_key" ON "organization_settings"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_settings_organization_id_id_key" ON "organization_settings"("organization_id", "id");

-- CreateIndex
CREATE INDEX "branches_organization_id_is_active_idx" ON "branches"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "branches_organization_id_id_key" ON "branches"("organization_id", "id");

-- CreateIndex
CREATE INDEX "organization_memberships_user_id_status_idx" ON "organization_memberships"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_organization_id_user_id_key" ON "organization_memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_organization_id_id_key" ON "organization_memberships"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_id_key" ON "roles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_key_key" ON "roles"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_system_key_key" ON "roles"("organization_id", "system_key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_membership_id_key" ON "staff_profiles"("membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_organization_id_id_key" ON "staff_profiles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_organization_id_membership_id_key" ON "staff_profiles"("organization_id", "membership_id");

-- CreateIndex
CREATE INDEX "services_organization_id_is_active_idx" ON "services"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "services_organization_id_id_key" ON "services"("organization_id", "id");

-- CreateIndex
CREATE INDEX "availability_rules_organization_id_staff_profile_id_weekday_idx" ON "availability_rules"("organization_id", "staff_profile_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "availability_rules_organization_id_id_key" ON "availability_rules"("organization_id", "id");

-- CreateIndex
CREATE INDEX "time_off_organization_id_staff_profile_id_starts_at_idx" ON "time_off"("organization_id", "staff_profile_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "time_off_organization_id_id_key" ON "time_off"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_email_status_idx" ON "organization_invitations"("organization_id", "email", "status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_organization_id_id_key" ON "organization_invitations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "platform_support_accesses_user_id_organization_id_expires_a_idx" ON "platform_support_accesses"("user_id", "organization_id", "expires_at");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_created_at_idx" ON "audit_events"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_support_access_id_created_at_idx" ON "audit_events"("support_access_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_organization_id_id_key" ON "audit_events"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_organization_id_role_id_fkey" FOREIGN KEY ("organization_id", "role_id") REFERENCES "roles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_organization_id_membership_id_fkey" FOREIGN KEY ("organization_id", "membership_id") REFERENCES "organization_memberships"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_organization_id_role_id_fkey" FOREIGN KEY ("organization_id", "role_id") REFERENCES "roles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_organization_id_membership_id_fkey" FOREIGN KEY ("organization_id", "membership_id") REFERENCES "organization_memberships"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_branch_assignments" ADD CONSTRAINT "staff_branch_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_branch_assignments" ADD CONSTRAINT "staff_branch_assignments_organization_id_staff_profile_id_fkey" FOREIGN KEY ("organization_id", "staff_profile_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_branch_assignments" ADD CONSTRAINT "staff_branch_assignments_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_branches" ADD CONSTRAINT "service_branches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_branches" ADD CONSTRAINT "service_branches_organization_id_service_id_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_branches" ADD CONSTRAINT "service_branches_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_organization_id_staff_profile_id_fkey" FOREIGN KEY ("organization_id", "staff_profile_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_organization_id_service_id_fkey" FOREIGN KEY ("organization_id", "service_id") REFERENCES "services"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_organization_id_staff_profile_id_fkey" FOREIGN KEY ("organization_id", "staff_profile_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_organization_id_staff_profile_id_fkey" FOREIGN KEY ("organization_id", "staff_profile_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_role_id_fkey" FOREIGN KEY ("organization_id", "role_id") REFERENCES "roles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_support_accesses" ADD CONSTRAINT "platform_support_accesses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_support_accesses" ADD CONSTRAINT "platform_support_accesses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Domain invariants that must hold regardless of the calling application.
CREATE UNIQUE INDEX "users_email_normalized_key" ON "users" (LOWER("email"));
CREATE UNIQUE INDEX "pending_invitation_email_key"
  ON "organization_invitations" ("organization_id", LOWER("email"))
  WHERE "status" = 'PENDING';

ALTER TABLE "organization_settings"
  ADD CONSTRAINT "organization_settings_booking_window_check"
  CHECK ("booking_window_days" BETWEEN 1 AND 730);
ALTER TABLE "services"
  ADD CONSTRAINT "services_duration_check" CHECK ("default_duration_mins" BETWEEN 1 AND 1440),
  ADD CONSTRAINT "services_price_check" CHECK ("default_price_minor" IS NULL OR "default_price_minor" >= 0);
ALTER TABLE "service_branches"
  ADD CONSTRAINT "service_branches_price_check" CHECK ("price_minor" IS NULL OR "price_minor" >= 0),
  ADD CONSTRAINT "service_branches_duration_check" CHECK ("duration_mins" IS NULL OR "duration_mins" BETWEEN 1 AND 1440),
  ADD CONSTRAINT "service_branches_buffers_check" CHECK ("buffer_before_mins" >= 0 AND "buffer_after_mins" >= 0),
  ADD CONSTRAINT "service_branches_booking_window_check" CHECK ("booking_window_days" IS NULL OR "booking_window_days" BETWEEN 1 AND 730);
ALTER TABLE "availability_rules"
  ADD CONSTRAINT "availability_rules_minutes_check"
  CHECK ("start_minute_local" BETWEEN 0 AND 1439 AND "end_minute_local" BETWEEN 1 AND 1440 AND "start_minute_local" < "end_minute_local"),
  ADD CONSTRAINT "availability_rules_dates_check"
  CHECK ("effective_until" IS NULL OR "effective_from" IS NULL OR "effective_from" <= "effective_until");
ALTER TABLE "time_off"
  ADD CONSTRAINT "time_off_range_check" CHECK ("starts_at" < "ends_at");
ALTER TABLE "platform_support_accesses"
  ADD CONSTRAINT "platform_support_access_range_check" CHECK ("starts_at" < "expires_at"),
  ADD CONSTRAINT "platform_support_access_reason_check" CHECK (LENGTH(BTRIM("reason")) >= 10);

-- Grant the migration owner membership in the runtime role for SET LOCAL ROLE.
DO $$
BEGIN
  EXECUTE FORMAT('GRANT jormall_app TO %I', CURRENT_USER);
END
$$;

GRANT USAGE ON SCHEMA public TO jormall_app;
GRANT SELECT ON "permissions" TO jormall_app;
GRANT SELECT ON "users" TO jormall_app;
GRANT SELECT ON "organizations" TO jormall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "organization_settings",
  "branches",
  "organization_memberships",
  "roles",
  "role_permissions",
  "membership_roles",
  "staff_profiles",
  "staff_branch_assignments",
  "services",
  "service_branches",
  "staff_services",
  "availability_rules",
  "time_off",
  "organization_invitations"
TO jormall_app;
GRANT SELECT, INSERT ON "audit_events" TO jormall_app;

-- Every tenant-owned table is filtered by a transaction-local organization ID.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organizations_tenant_isolation" ON "organizations"
  USING ("id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "organization_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_settings_tenant_isolation" ON "organization_settings"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "branches_tenant_isolation" ON "branches"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_memberships_tenant_isolation" ON "organization_memberships"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "roles_tenant_isolation" ON "roles"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "role_permissions_tenant_isolation" ON "role_permissions"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "membership_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "membership_roles_tenant_isolation" ON "membership_roles"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "staff_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "staff_profiles_tenant_isolation" ON "staff_profiles"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "staff_branch_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_branch_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "staff_branch_assignments_tenant_isolation" ON "staff_branch_assignments"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "services" FORCE ROW LEVEL SECURITY;
CREATE POLICY "services_tenant_isolation" ON "services"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "service_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_branches_tenant_isolation" ON "service_branches"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "staff_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_services" FORCE ROW LEVEL SECURITY;
CREATE POLICY "staff_services_tenant_isolation" ON "staff_services"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "availability_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "availability_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "availability_rules_tenant_isolation" ON "availability_rules"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "time_off" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "time_off" FORCE ROW LEVEL SECURITY;
CREATE POLICY "time_off_tenant_isolation" ON "time_off"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "organization_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_invitations_tenant_isolation" ON "organization_invitations"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_events_tenant_isolation" ON "audit_events"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
