import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/**/*.browser.test.ts",
      "build/acceptance/generated/passing-scenario-completes-run.acceptance.test.ts",
    ],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
