ALTER TABLE "customer_contacts"
  DROP CONSTRAINT "customer_contacts_jordan_phone_check";

ALTER TABLE "customer_contacts"
  ADD CONSTRAINT "customer_contacts_jordan_phone_check"
  CHECK (
    "normalized_phone_e164" IS NULL OR "normalized_phone_e164" ~ '^\+962[2-9][0-9]{7,8}$'
  );
