-- Route an opaque website session nonce without disclosing tenant or row identifiers to clients.
GRANT SELECT (
  "id", "organization_id", "channel", "external_key_hash", "status", "expires_at"
) ON "ai_channel_sessions" TO jormall_channel_router;

CREATE POLICY "ai_channel_sessions_public_routing"
ON "ai_channel_sessions"
FOR SELECT
TO jormall_channel_router
USING (
  "channel" = 'WEBSITE'
  AND "status" = 'OPEN'
  AND "expires_at" > CURRENT_TIMESTAMP
);
