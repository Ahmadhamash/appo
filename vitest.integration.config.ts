import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/integration/**/*.integration.test.ts"],
    maxWorkers: 1,
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
