import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
    ],
    setupFiles: ["packages/shared-config/src/vitest-setup.ts"],
  },
});
