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
  required_code TEXT;
  required_codes TEXT[];
BEGIN
  IF NULLIF(current_setting('app.organization_id', true), '')::UUID
       IS DISTINCT FROM p_organization_id THEN
    RETURN false;
  END IF;

  IF p_lease_token IS NULL
    OR (p_membership_id IS NULL) = (p_support_access_id IS NULL) THEN
    RETURN false;
  END IF;

  SELECT job."membership_id", job."support_access_id", job."capability",
         job."branch_id", job."appointment_id"
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

  required_codes := ARRAY['predictions.run']::TEXT[] ||
    CASE locked_job."capability"::TEXT
      WHEN 'NO_SHOW' THEN ARRAY['appointments.read']::TEXT[]
      WHEN 'DEMAND_FORECAST' THEN ARRAY['reports.read']::TEXT[]
      WHEN 'STAFFING' THEN ARRAY['reports.read', 'schedules.read']::TEXT[]
      WHEN 'SCHEDULE_REFLOW' THEN ARRAY['appointments.read', 'schedules.read', 'resources.read']::TEXT[]
      WHEN 'SERVICE_PROVIDER_RECOMMENDATION' THEN
        ARRAY['services.read', 'staff.read', 'appointments.availability.read']::TEXT[]
      ELSE ARRAY[]::TEXT[]
    END;

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

    FOREACH required_code IN ARRAY required_codes LOOP
      PERFORM 1
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
        AND permission_row."code" = required_code
        AND role_permission."scope" = 'ORGANIZATION'
      LIMIT 1
      FOR SHARE OF membership_role, role_row, role_permission, permission_row;
      IF FOUND THEN
        CONTINUE;
      END IF;

      IF locked_job."branch_id" IS NOT NULL THEN
        PERFORM 1
        FROM public."membership_roles" membership_role
        JOIN public."roles" role_row
          ON role_row."organization_id" = membership_role."organization_id"
         AND role_row."id" = membership_role."role_id"
        JOIN public."role_permissions" role_permission
          ON role_permission."organization_id" = role_row."organization_id"
         AND role_permission."role_id" = role_row."id"
        JOIN public."permissions" permission_row
          ON permission_row."id" = role_permission."permission_id"
        JOIN public."staff_profiles" staff_profile
          ON staff_profile."organization_id" = membership_role."organization_id"
         AND staff_profile."membership_id" = membership_role."membership_id"
        JOIN public."staff_branch_assignments" assignment
          ON assignment."organization_id" = staff_profile."organization_id"
         AND assignment."staff_profile_id" = staff_profile."id"
         AND assignment."branch_id" = locked_job."branch_id"
        WHERE membership_role."organization_id" = p_organization_id
          AND membership_role."membership_id" = p_membership_id
          AND permission_row."code" = required_code
          AND role_permission."scope" = 'ASSIGNED_BRANCHES'
        LIMIT 1
        FOR SHARE OF membership_role, role_row, role_permission, permission_row,
                     staff_profile, assignment;
        IF FOUND THEN
          CONTINUE;
        END IF;
      END IF;

      IF locked_job."appointment_id" IS NOT NULL THEN
        PERFORM 1
        FROM public."membership_roles" membership_role
        JOIN public."roles" role_row
          ON role_row."organization_id" = membership_role."organization_id"
         AND role_row."id" = membership_role."role_id"
        JOIN public."role_permissions" role_permission
          ON role_permission."organization_id" = role_row."organization_id"
         AND role_permission."role_id" = role_row."id"
        JOIN public."permissions" permission_row
          ON permission_row."id" = role_permission."permission_id"
        JOIN public."staff_profiles" staff_profile
          ON staff_profile."organization_id" = membership_role."organization_id"
         AND staff_profile."membership_id" = membership_role."membership_id"
        JOIN public."appointments" appointment
          ON appointment."organization_id" = staff_profile."organization_id"
         AND appointment."id" = locked_job."appointment_id"
         AND appointment."provider_id" = staff_profile."id"
        WHERE membership_role."organization_id" = p_organization_id
          AND membership_role."membership_id" = p_membership_id
          AND permission_row."code" = required_code
          AND role_permission."scope" = 'SELF'
        LIMIT 1
        FOR SHARE OF membership_role, role_row, role_permission, permission_row,
                     staff_profile, appointment;
        IF FOUND THEN
          CONTINUE;
        END IF;
      END IF;

      RETURN false;
    END LOOP;
  ELSE
    PERFORM 1
    FROM public."platform_support_accesses" support_access
    WHERE support_access."organization_id" = p_organization_id
      AND support_access."id" = p_support_access_id
      AND support_access."user_id" = p_actor_user_id
      AND support_access."revoked_at" IS NULL
      AND support_access."expires_at" > CURRENT_TIMESTAMP
      AND support_access."permission_codes" @> required_codes
    FOR SHARE OF support_access;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END
$$;
