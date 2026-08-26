ALTER TABLE "predictive_jobs"
ADD CONSTRAINT "predictive_jobs_evaluation_after_request"
CHECK ("evaluation_at" IS NULL OR "evaluation_at" >= "created_at");

CREATE FUNCTION protect_predictive_job_evaluation_watermark() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."evaluation_at" IS NOT NULL
    AND NEW."evaluation_at" IS DISTINCT FROM OLD."evaluation_at" THEN
    RAISE EXCEPTION 'predictive job evaluation watermark is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER predictive_jobs_evaluation_watermark
BEFORE UPDATE ON "predictive_jobs"
FOR EACH ROW EXECUTE FUNCTION protect_predictive_job_evaluation_watermark();
