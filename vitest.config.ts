import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.config.{js,mjs,ts}", "**/*.d.ts", "**/src/generated/**"],
      include: ["packages/*/src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.{ts,tsx}"],
    exclude: ["**/*.integration.test.{ts,tsx}", "**/node_modules/**"],
    passWithNoTests: false,
    restoreMocks: true,
  },
});
