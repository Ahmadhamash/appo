ALTER TABLE "predictive_jobs" ADD COLUMN "lease_token" UUID;

CREATE OR REPLACE FUNCTION lock_predictive_evidence_authorization(
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
DECLARE
  locked_job RECORD;
BEGIN
  IF NULLIF(current_setting('app.organization_id', true), '')::UUID
       IS DISTINCT FROM p_organization_id THEN
    RETURN false;
  END IF;

  IF p_lease_token IS NULL
    OR (p_membership_id IS NULL) = (p_support_access_id IS NULL) THEN
    RETURN false;
  END IF;

  SELECT job."membership_id", job."support_access_id"
  INTO locked_job
  FROM public."predictive_jobs" job
  JOIN public."organizations" organization
    ON organization."id" = job."organization_id"
  JOIN public."predictive_capability_settings" setting
    ON setting."organization_id" = job."organization_id"
   AND setting."capability" = job."capability"
  WHERE job."organization_id" = p_organization_id
    AND job."id" = p_job_id
    AND job."actor_user_id" = p_actor_user_id
    AND job."lease_token" = p_lease_token
    AND job."status" = 'RUNNING'
    AND organization."status" = 'ACTIVE'
    AND (job."job_type" = 'DATA_AUDIT' OR p_allow_disabled OR setting."enabled")
  FOR SHARE OF job, organization, setting;

  IF NOT FOUND
    OR locked_job."membership_id" IS DISTINCT FROM p_membership_id
    OR locked_job."support_access_id" IS DISTINCT FROM p_support_access_id THEN
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
  ELSE
    PERFORM 1
    FROM public."platform_support_accesses" support_access
    WHERE support_access."organization_id" = p_organization_id
      AND support_access."id" = p_support_access_id
      AND support_access."user_id" = p_actor_user_id
      AND support_access."revoked_at" IS NULL
      AND support_access."expires_at" > CURRENT_TIMESTAMP
    FOR SHARE OF support_access;
  END IF;

  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION lock_predictive_evidence_authorization(UUID, UUID, UUID, UUID, UUID, UUID, BOOLEAN)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_predictive_evidence_authorization(UUID, UUID, UUID, UUID, UUID, UUID, BOOLEAN)
TO jormall_app;

DROP FUNCTION lock_predictive_evidence_authorization(UUID, UUID, UUID, UUID, UUID, BOOLEAN);
