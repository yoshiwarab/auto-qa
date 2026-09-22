import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function runHook(hook: string, failCommand = "") {
  return spawnSync(
    "sh",
    [
      "-c",
      `
        fnm() {
          printf '%s\\n' "$*"
          if [ "$*" = "$FAIL_COMMAND" ]; then return 73; fi
        }
        . "$1"
      `,
      "hook-test",
      `./.husky/${hook}`,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, FAIL_COMMAND: failCommand },
      timeout: 5_000,
    }
  );
}

describe("repository Git hooks", () => {
  test("commit formats staged files then runs the fast gate on Node 22", () => {
    const result = runHook("pre-commit");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "exec --using 22 pnpm exec lint-staged",
      "exec --using 22 pnpm check",
    ]);
  });

  test("commit stops when staged formatting fails", () => {
    const result = runHook(
      "pre-commit",
      "exec --using 22 pnpm exec lint-staged"
    );
    expect(result.status, result.stderr).toBe(73);
    expect(result.stdout.trim()).toBe("exec --using 22 pnpm exec lint-staged");
  });

  test("push runs the push gate on Node 22 and propagates failures", () => {
    const command = "exec --using 22 pnpm verify:push";
    const success = runHook("pre-push");
    expect(success.status, success.stderr).toBe(0);
    expect(success.stdout.trim()).toBe(command);
    expect(runHook("pre-push", command).status).toBe(73);
  });
});
