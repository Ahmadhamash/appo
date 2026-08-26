import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

const rootEnvironmentPath = fileURLToPath(new URL("../../../.env", import.meta.url));

if (existsSync(rootEnvironmentPath)) {
  process.loadEnvFile(rootEnvironmentPath);
}

await import("next/dist/bin/next");
