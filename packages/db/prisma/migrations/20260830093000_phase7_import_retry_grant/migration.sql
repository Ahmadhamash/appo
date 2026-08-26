GRANT DELETE ON "import_rows" TO jormall_app;

UPDATE "role_permissions" AS rp
SET "scope" = 'ORGANIZATION'::"PermissionScope"
FROM "roles" AS r, "permissions" AS p
WHERE rp."organization_id" = r."organization_id"
  AND rp."role_id" = r."id"
  AND rp."permission_id" = p."id"
  AND r."system_key" = 'ORGANIZATION_MANAGER'::"TenantRoleKey"
  AND p."code" = 'imports.manage';
