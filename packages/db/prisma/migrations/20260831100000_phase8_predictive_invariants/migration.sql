ALTER TABLE "predictive_jobs"
ADD CONSTRAINT "predictive_jobs_processed_within_total" CHECK (
  "processed_rows" <= "total_rows"
),
ADD CONSTRAINT "predictive_jobs_exactly_one_lineage" CHECK (
  ("membership_id" IS NOT NULL) <> ("support_access_id" IS NOT NULL)
);

ALTER TABLE "predictive_drift_runs"
ADD CONSTRAINT "predictive_drift_runs_status_score" CHECK (
  ("status" = 'INSUFFICIENT' AND "score" IS NULL)
  OR ("status" <> 'INSUFFICIENT' AND "score" IS NOT NULL)
);

CREATE FUNCTION protect_predictive_model_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'predictive model versions cannot be deleted';
  END IF;
  IF (to_jsonb(OLD) - 'is_active') IS DISTINCT FROM (to_jsonb(NEW) - 'is_active') THEN
    RAISE EXCEPTION 'predictive model version evidence is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER predictive_model_versions_protect
BEFORE UPDATE OR DELETE ON "predictive_model_versions"
FOR EACH ROW EXECUTE FUNCTION protect_predictive_model_version();
