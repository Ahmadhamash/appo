CREATE FUNCTION protect_operational_calendar_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operational calendar event versions cannot be deleted';
  END IF;
  IF (to_jsonb(OLD) - 'is_active') IS DISTINCT FROM (to_jsonb(NEW) - 'is_active') THEN
    RAISE EXCEPTION 'operational calendar event versions are immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER operational_calendar_events_protect
BEFORE UPDATE OR DELETE ON "operational_calendar_events"
FOR EACH ROW EXECUTE FUNCTION protect_operational_calendar_event();
