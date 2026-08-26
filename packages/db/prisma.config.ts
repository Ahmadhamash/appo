import { config as loadEnvironment } from "dotenv";
import { defineConfig, env } from "prisma/config";
import { fileURLToPath } from "node:url";

loadEnvironment({
  path: fileURLToPath(new URL("../../.env", import.meta.url)),
  quiet: true,
});

export default defineConfig({
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    path: "prisma/migrations",
    seed: "pnpm --filter @jormall/web seed",
  },
  schema: "prisma/schema.prisma",
});
