-- Phase 8 predictive features must not join an append-only historical event to the
-- appointment's mutable present-day dimensions. New history events therefore capture
-- their tenant-local dimensions in the same insert. Existing rows are backfilled for
-- inspection only and deliberately remain unverified so predictive work fails closed.
ALTER TABLE "appointment_status_history"
  ADD COLUMN "branch_snapshot_id" UUID,
  ADD COLUMN "service_snapshot_id" UUID,
  ADD COLUMN "provider_snapshot_id" UUID,
  ADD COLUMN "customer_snapshot_id" UUID,
  ADD COLUMN "timezone_snapshot" VARCHAR(100),
  ADD COLUMN "dimension_snapshot_verified_at" TIMESTAMPTZ(3);

DROP TRIGGER "appointment_status_history_immutable" ON "appointment_status_history";

UPDATE "appointment_status_history" AS history
SET "branch_snapshot_id" = appointment."branch_id",
    "service_snapshot_id" = appointment."service_id",
    "provider_snapshot_id" = appointment."provider_id",
    "customer_snapshot_id" = appointment."customer_id",
    "timezone_snapshot" = appointment."timezone"
FROM "appointments" AS appointment
WHERE appointment."organization_id" = history."organization_id"
  AND appointment."id" = history."appointment_id";

CREATE TRIGGER "appointment_status_history_immutable"
BEFORE UPDATE OR DELETE ON "appointment_status_history"
FOR EACH ROW EXECUTE FUNCTION prevent_phase2_append_only_mutation();

ALTER TABLE "appointment_status_history"
  ADD CONSTRAINT "appointment_status_history_verified_dimensions_check"
  CHECK (
    "dimension_snapshot_verified_at" IS NULL
    OR (
      "branch_snapshot_id" IS NOT NULL
      AND "service_snapshot_id" IS NOT NULL
      AND "provider_snapshot_id" IS NOT NULL
      AND "customer_snapshot_id" IS NOT NULL
      AND "timezone_snapshot" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "appointment_status_history_branch_snapshot_fkey"
  FOREIGN KEY ("organization_id", "branch_snapshot_id")
  REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "appointment_status_history_service_snapshot_fkey"
  FOREIGN KEY ("organization_id", "service_snapshot_id")
  REFERENCES "services"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "appointment_status_history_provider_snapshot_fkey"
  FOREIGN KEY ("organization_id", "provider_snapshot_id")
  REFERENCES "staff_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "appointment_status_history_customer_snapshot_fkey"
  FOREIGN KEY ("organization_id", "customer_snapshot_id")
  REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "appointment_status_history_organization_id_event_type_created_at_id_idx"
  ON "appointment_status_history"("organization_id", "event_type", "created_at", "id");

CREATE OR REPLACE FUNCTION capture_appointment_history_dimensions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  snapshot RECORD;
BEGIN
  SELECT appointment."branch_id",
         appointment."service_id",
         appointment."provider_id",
         appointment."customer_id",
         appointment."timezone"
  INTO STRICT snapshot
  FROM public."appointments" AS appointment
  WHERE appointment."organization_id" = NEW."organization_id"
    AND appointment."id" = NEW."appointment_id";

  NEW."branch_snapshot_id" := snapshot."branch_id";
  NEW."service_snapshot_id" := snapshot."service_id";
  NEW."provider_snapshot_id" := snapshot."provider_id";
  NEW."customer_snapshot_id" := snapshot."customer_id";
  NEW."timezone_snapshot" := snapshot."timezone";
  NEW."dimension_snapshot_verified_at" := statement_timestamp();
  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'appointment history tenant/appointment binding is invalid';
END;
$$;

REVOKE ALL ON FUNCTION capture_appointment_history_dimensions() FROM PUBLIC;

CREATE TRIGGER "appointment_status_history_capture_dimensions"
BEFORE INSERT ON "appointment_status_history"
FOR EACH ROW EXECUTE FUNCTION capture_appointment_history_dimensions();
