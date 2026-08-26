ALTER TABLE "predictive_jobs" ADD COLUMN "evaluation_at" TIMESTAMPTZ(3);
UPDATE "predictive_jobs"
SET "evaluation_at" = COALESCE("started_at", "created_at")
WHERE "started_at" IS NOT NULL;

CREATE FUNCTION lock_predictive_foreground_authorization(
  p_organization_id UUID,
  p_actor_user_id UUID,
  p_membership_id UUID,
  p_support_access_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.organization_id', true), '')::UUID
       IS DISTINCT FROM p_organization_id
    OR (p_membership_id IS NULL) = (p_support_access_id IS NULL) THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM public."organizations" organization
  WHERE organization."id" = p_organization_id
    AND organization."status" = 'ACTIVE'
  FOR SHARE OF organization;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_membership_id IS NOT NULL THEN
    PERFORM 1
    FROM public."organization_memberships" membership
    WHERE membership."organization_id" = p_organization_id
      AND membership."id" = p_membership_id
      AND membership."user_id" = p_actor_user_id
      AND membership."status" = 'ACTIVE'
    FOR SHARE OF membership;
    IF NOT FOUND THEN
      RETURN false;
    END IF;

    PERFORM membership_role."membership_id"
    FROM public."membership_roles" membership_role
    JOIN public."roles" role_row
      ON role_row."organization_id" = membership_role."organization_id"
     AND role_row."id" = membership_role."role_id"
    WHERE membership_role."organization_id" = p_organization_id
      AND membership_role."membership_id" = p_membership_id
    FOR SHARE OF membership_role, role_row;

    PERFORM role_permission."permission_id"
    FROM public."membership_roles" membership_role
    JOIN public."roles" role_row
      ON role_row."organization_id" = membership_role."organization_id"
     AND role_row."id" = membership_role."role_id"
    JOIN public."role_permissions" role_permission
      ON role_permission."organization_id" = role_row."organization_id"
     AND role_permission."role_id" = role_row."id"
    JOIN public."permissions" permission_row
      ON permission_row."id" = role_permission."permission_id"
    WHERE membership_role."organization_id" = p_organization_id
      AND membership_role."membership_id" = p_membership_id
    FOR SHARE OF membership_role, role_row, role_permission, permission_row;

    PERFORM staff_profile."id"
    FROM public."staff_profiles" staff_profile
    WHERE staff_profile."organization_id" = p_organization_id
      AND staff_profile."membership_id" = p_membership_id
    FOR SHARE OF staff_profile;

    PERFORM assignment."branch_id"
    FROM public."staff_profiles" staff_profile
    JOIN public."staff_branch_assignments" assignment
      ON assignment."organization_id" = staff_profile."organization_id"
     AND assignment."staff_profile_id" = staff_profile."id"
    WHERE staff_profile."organization_id" = p_organization_id
      AND staff_profile."membership_id" = p_membership_id
    FOR SHARE OF staff_profile, assignment;
  ELSE
    PERFORM 1
    FROM public."platform_support_accesses" support_access
    JOIN public."users" user_row ON user_row."id" = support_access."user_id"
    WHERE support_access."organization_id" = p_organization_id
      AND support_access."id" = p_support_access_id
      AND support_access."user_id" = p_actor_user_id
      AND support_access."starts_at" <= CURRENT_TIMESTAMP
      AND support_access."expires_at" > CURRENT_TIMESTAMP
      AND support_access."revoked_at" IS NULL
      AND user_row."platform_role" = 'JORMALL_SUPER_ADMIN'
    FOR SHARE OF support_access, user_row;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION lock_predictive_foreground_authorization(UUID, UUID, UUID, UUID)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_predictive_foreground_authorization(UUID, UUID, UUID, UUID)
TO jormall_app;

CREATE FUNCTION lock_predictive_evidence_authorization_v2(
  p_organization_id UUID,
  p_job_id UUID,
  p_actor_user_id UUID,
  p_membership_id UUID,
  p_support_access_id UUID,
  p_lease_token UUID,
  p_allow_disabled BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.lock_predictive_foreground_authorization(
    p_organization_id,
    p_actor_user_id,
    p_membership_id,
    p_support_access_id
  ) THEN
    RETURN false;
  END IF;

  RETURN public.lock_predictive_evidence_authorization(
    p_organization_id,
    p_job_id,
    p_actor_user_id,
    p_membership_id,
    p_support_access_id,
    p_lease_token,
    p_allow_disabled
  );
END
$$;

REVOKE EXECUTE ON FUNCTION lock_predictive_evidence_authorization(UUID, UUID, UUID, UUID, UUID, UUID, BOOLEAN)
FROM jormall_app;
REVOKE ALL ON FUNCTION lock_predictive_evidence_authorization_v2(UUID, UUID, UUID, UUID, UUID, UUID, BOOLEAN)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_predictive_evidence_authorization_v2(UUID, UUID, UUID, UUID, UUID, UUID, BOOLEAN)
TO jormall_app;
