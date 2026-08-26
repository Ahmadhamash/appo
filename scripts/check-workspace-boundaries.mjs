import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const allowedInternalDependencies = new Map([
  [
    "@jormall/web",
    new Set([
      "@jormall/ai",
      "@jormall/auth",
      "@jormall/config",
      "@jormall/contracts",
      "@jormall/db",
      "@jormall/domain",
      "@jormall/ui",
    ]),
  ],
  [
    "@jormall/worker",
    new Set([
      "@jormall/ai",
      "@jormall/auth",
      "@jormall/config",
      "@jormall/contracts",
      "@jormall/db",
      "@jormall/domain",
    ]),
  ],
  ["@jormall/ai", new Set(["@jormall/auth", "@jormall/contracts", "@jormall/domain"])],
  ["@jormall/auth", new Set(["@jormall/contracts", "@jormall/domain"])],
  ["@jormall/config", new Set()],
  ["@jormall/contracts", new Set()],
  ["@jormall/db", new Set(["@jormall/config", "@jormall/domain"])],
  ["@jormall/domain", new Set()],
  ["@jormall/ui", new Set(["@jormall/contracts"])],
]);

const packageDirectories = ["apps", "packages"].flatMap((parent) => {
  const parentPath = join(repositoryRoot, parent);
  if (!existsSync(parentPath)) {
    return [];
  }

  return readdirSync(parentPath)
    .map((name) => join(parentPath, name))
    .filter((path) => statSync(path).isDirectory() && existsSync(join(path, "package.json")));
});

const violations = [];

for (const packageDirectory of packageDirectories) {
  const manifestPath = join(packageDirectory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const allowed = allowedInternalDependencies.get(manifest.name);

  if (!allowed) {
    violations.push(
      `${relative(repositoryRoot, manifestPath)}: unknown workspace package ${manifest.name}`,
    );
    continue;
  }

  const dependencySections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
  ];
  for (const dependencies of dependencySections) {
    if (!dependencies) {
      continue;
    }

    for (const dependencyName of Object.keys(dependencies)) {
      if (dependencyName.startsWith("@jormall/") && !allowed.has(dependencyName)) {
        violations.push(`${manifest.name} may not depend on ${dependencyName}`);
      }
    }
  }

  const sourceDirectory = join(packageDirectory, "src");
  if (!existsSync(sourceDirectory)) {
    continue;
  }

  for (const sourcePath of walkSourceFiles(sourceDirectory)) {
    const source = readFileSync(sourcePath, "utf8");
    if (/from\s+["']@jormall\/[a-z-]+["']/.test(source)) {
      violations.push(
        `${relative(repositoryRoot, sourcePath)}: import an explicit package subpath; barrel imports are forbidden`,
      );
    }
    if (/[/\\]index\.(ts|tsx)$/.test(sourcePath)) {
      violations.push(`${relative(repositoryRoot, sourcePath)}: index source files are forbidden`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Workspace boundary violations:\n${violations.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Workspace dependency boundaries are valid.\n");
}

function walkSourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return walkSourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
