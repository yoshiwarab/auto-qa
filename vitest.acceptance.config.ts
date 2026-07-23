import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["build/acceptance/generated/**/*.acceptance.test.ts"],
  },
});
