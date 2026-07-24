import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ".worktrees/**",
      "build/**",
      "dist/**",
      "node_modules/**",
      "tmp/**",
    ],
  },
});
