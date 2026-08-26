ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_tenant_visibility" ON "users"
  FOR SELECT
  USING (
    "id" = NULLIF(CURRENT_SETTING('app.actor_user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1
      FROM "organization_memberships" AS membership
      WHERE membership."user_id" = "users"."id"
        AND membership."organization_id" = NULLIF(CURRENT_SETTING('app.organization_id', true), '')::uuid
    )
  );

CREATE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

CREATE TRIGGER "audit_events_immutable"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
