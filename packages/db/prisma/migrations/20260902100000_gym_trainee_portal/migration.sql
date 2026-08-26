CREATE TYPE "GymPortalAccessStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "GymAvatarSkinTone" AS ENUM ('LIGHT', 'MEDIUM', 'TAN', 'DARK');
CREATE TYPE "GymAvatarFrame" AS ENUM ('SLIM', 'ATHLETIC', 'BROAD');
CREATE TYPE "GymAvatarHairStyle" AS ENUM ('SHORT', 'CURLY', 'COVERED', 'BALD');

ALTER TABLE "gym_trainee_profiles"
  ADD COLUMN "avatar_skin_tone" "GymAvatarSkinTone" NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN "avatar_frame" "GymAvatarFrame" NOT NULL DEFAULT 'ATHLETIC',
  ADD COLUMN "avatar_hair_style" "GymAvatarHairStyle" NOT NULL DEFAULT 'SHORT',
  ADD COLUMN "avatar_shirt_color" VARCHAR(7) NOT NULL DEFAULT '#d6a63c',
  ADD CONSTRAINT "gym_trainee_profiles_avatar_color" CHECK ("avatar_shirt_color" ~ '^#[0-9A-Fa-f]{6}$');

CREATE TABLE "gym_trainee_portal_accesses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "trainee_profile_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "status" "GymPortalAccessStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "gym_trainee_portal_accesses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gym_trainee_invitations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "trainee_profile_id" UUID NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
  "invited_by_user_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "accepted_at" TIMESTAMPTZ(3),
  "accepted_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "gym_trainee_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gym_trainee_portal_accesses_user_id_key" ON "gym_trainee_portal_accesses"("user_id");
CREATE UNIQUE INDEX "gym_trainee_portal_accesses_organization_id_id_key" ON "gym_trainee_portal_accesses"("organization_id", "id");
CREATE UNIQUE INDEX "gym_trainee_portal_accesses_organization_id_trainee_profile_id_key" ON "gym_trainee_portal_accesses"("organization_id", "trainee_profile_id");
CREATE INDEX "gym_trainee_portal_accesses_organization_id_status_idx" ON "gym_trainee_portal_accesses"("organization_id", "status");
CREATE UNIQUE INDEX "gym_trainee_invitations_token_hash_key" ON "gym_trainee_invitations"("token_hash");
CREATE UNIQUE INDEX "gym_trainee_invitations_organization_id_id_key" ON "gym_trainee_invitations"("organization_id", "id");
CREATE INDEX "gym_trainee_invitations_organization_id_trainee_profile_id_status_idx" ON "gym_trainee_invitations"("organization_id", "trainee_profile_id", "status");
CREATE INDEX "gym_trainee_invitations_organization_id_email_status_idx" ON "gym_trainee_invitations"("organization_id", "email", "status");
CREATE UNIQUE INDEX "gym_trainee_invitations_one_pending_per_trainee"
  ON "gym_trainee_invitations"("organization_id", "trainee_profile_id")
  WHERE "status" = 'PENDING';

ALTER TABLE "gym_trainee_portal_accesses" ADD CONSTRAINT "gym_trainee_portal_accesses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_trainee_portal_accesses" ADD CONSTRAINT "gym_trainee_portal_accesses_trainee_fkey" FOREIGN KEY ("organization_id", "trainee_profile_id") REFERENCES "gym_trainee_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_trainee_portal_accesses" ADD CONSTRAINT "gym_trainee_portal_accesses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_trainee_invitations" ADD CONSTRAINT "gym_trainee_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_trainee_invitations" ADD CONSTRAINT "gym_trainee_invitations_trainee_fkey" FOREIGN KEY ("organization_id", "trainee_profile_id") REFERENCES "gym_trainee_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_trainee_invitations" ADD CONSTRAINT "gym_trainee_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "gym_trainee_portal_accesses", "gym_trainee_invitations" TO jormall_app;

ALTER TABLE "gym_trainee_portal_accesses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gym_trainee_portal_accesses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "gym_trainee_portal_accesses_tenant_isolation" ON "gym_trainee_portal_accesses"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);

ALTER TABLE "gym_trainee_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gym_trainee_invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "gym_trainee_invitations_tenant_isolation" ON "gym_trainee_invitations"
  USING ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid);
