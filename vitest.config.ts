import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/web/src/server/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./scripts/load-local-env.mjs"],
  },
});
