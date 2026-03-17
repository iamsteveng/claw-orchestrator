import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Point @prisma/client to the generated client at the workspace root.
      // Without this alias, pnpm's symlink resolution causes vitest to load
      // the un-generated stub from the pnpm store when running tests
      // from the workspace root (e.g. tests/integration/).
      "@prisma/client": path.resolve(
        __dirname,
        "node_modules/.prisma/client/index.js"
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    setupFiles: ["packages/shared-config/src/vitest-setup.ts"],
  },
});
