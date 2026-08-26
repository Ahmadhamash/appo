import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";

const applicationDirectory = resolve(process.cwd());
const generatedDevelopmentTypes = resolve(applicationDirectory, ".next", "dev", "types");

if (!generatedDevelopmentTypes.startsWith(`${applicationDirectory}${sep}`)) {
  throw new Error("Refusing to remove generated types outside the web application directory.");
}

rmSync(generatedDevelopmentTypes, { force: true, recursive: true });

run(["exec", "next", "typegen"]);
run(["exec", "tsc", "--noEmit"]);

function run(arguments_) {
  const packageManagerExecutable = process.env.npm_execpath;
  if (!packageManagerExecutable) {
    throw new Error("The pnpm executable path is unavailable.");
  }

  const result = spawnSync(process.execPath, [packageManagerExecutable, ...arguments_], {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
