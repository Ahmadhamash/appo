REVOKE UPDATE ON "predictive_jobs" FROM jormall_relay;
GRANT UPDATE (
  "status",
  "safe_error_code",
  "updated_at",
  "completed_at",
  "claimed_at",
  "claimed_by",
  "lease_token",
  "enqueued_at"
) ON "predictive_jobs" TO jormall_relay;

CREATE FUNCTION protect_predictive_job_relay_envelope() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reclaimable BOOLEAN;
BEGIN
  IF CURRENT_USER <> 'jormall_relay' THEN
    RETURN NEW;
  END IF;

  reclaimable :=
    OLD."status" = 'PENDING'
    OR (OLD."status" = 'CLAIMED'
        AND OLD."claimed_at" < CURRENT_TIMESTAMP - INTERVAL '2 minutes')
    OR (OLD."status" = 'ENQUEUED'
        AND OLD."enqueued_at" < CURRENT_TIMESTAMP - INTERVAL '5 minutes')
    OR (OLD."status" = 'RUNNING'
        AND OLD."started_at" < CURRENT_TIMESTAMP - INTERVAL '30 minutes');

  IF NEW."status" = 'CLAIMED' THEN
    IF NOT reclaimable OR OLD."attempts" >= OLD."max_attempts" THEN
      RAISE EXCEPTION 'predictive relay cannot claim this job';
    END IF;
    IF (to_jsonb(OLD) - ARRAY[
          'status', 'claimed_at', 'claimed_by', 'lease_token', 'updated_at'
        ]) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY[
          'status', 'claimed_at', 'claimed_by', 'lease_token', 'updated_at'
        ]) THEN
      RAISE EXCEPTION 'predictive relay claim changed protected columns';
    END IF;
    IF NEW."claimed_at" IS NULL
      OR NEW."claimed_by" IS NULL
      OR length(btrim(NEW."claimed_by")) NOT BETWEEN 1 AND 120
      OR NEW."lease_token" IS NULL
      OR (OLD."status" = 'CLAIMED' AND OLD."lease_token" IS NOT NULL
          AND NEW."lease_token" IS DISTINCT FROM OLD."lease_token") THEN
      RAISE EXCEPTION 'predictive relay claim envelope is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'CLAIMED' AND NEW."status" = 'ENQUEUED' THEN
    IF (to_jsonb(OLD) - ARRAY['status', 'enqueued_at', 'updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY['status', 'enqueued_at', 'updated_at'])
      OR NEW."enqueued_at" IS NULL
      OR NEW."lease_token" IS DISTINCT FROM OLD."lease_token" THEN
      RAISE EXCEPTION 'predictive relay enqueue envelope is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = 'DEAD_LETTER' THEN
    IF NOT reclaimable OR OLD."attempts" < OLD."max_attempts" THEN
      RAISE EXCEPTION 'predictive relay cannot dead-letter this job';
    END IF;
    IF (to_jsonb(OLD) - ARRAY[
          'status', 'safe_error_code', 'completed_at', 'updated_at'
        ]) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY[
          'status', 'safe_error_code', 'completed_at', 'updated_at'
        ])
      OR NEW."completed_at" IS NULL
      OR NEW."safe_error_code" IS DISTINCT FROM 'MAX_ATTEMPTS_EXCEEDED' THEN
      RAISE EXCEPTION 'predictive relay dead-letter envelope is invalid';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'predictive relay transition is not allowed';
END
$$;

CREATE TRIGGER predictive_jobs_relay_envelope
BEFORE UPDATE ON "predictive_jobs"
FOR EACH ROW EXECUTE FUNCTION protect_predictive_job_relay_envelope();
