import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "src/cli.ts",
        "src/cliApplication.ts",
        "src/gitChangeInspector.ts",
        "src/gitWorktree.ts",
      ],
      include: ["src/**/*.ts"],
      reporter: ["text"],
      reportsDirectory: "build/coverage",
    },
    exclude: [
      ".repos/**",
      ".worktrees/**",
      "build/**",
      "dist/**",
      "node_modules/**",
      "tmp/**",
    ],
  },
});
