import { execFile } from "node:child_process";
import { Effect } from "effect";
import {
  ChangeInspectionError,
  type ChangeInspector,
} from "./workflowEngine.js";
import type { Change } from "./workflowProtocol.js";

const inspectGitStatus = (
  worktree: string,
): Effect.Effect<string, ChangeInspectionError> =>
  Effect.async<string, ChangeInspectionError>((resume) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: worktree, encoding: "utf8" },
      (error, stdout) => {
        resume(
          error === null
            ? Effect.succeed(stdout)
            : Effect.fail(
                new ChangeInspectionError(
                  "Could not inspect Git changes",
                  error,
                ),
              ),
        );
      },
    );
  });

const changeKind = (status: string): string => {
  if (status === "??") {
    return "added";
  }
  if (status.includes("D")) {
    return "deleted";
  }
  if (status.includes("R")) {
    return "renamed";
  }
  return "modified";
};

const parseStatus = (status: string): readonly Change[] => {
  const entries = status.split("\0");
  const changes: Change[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length === 0) {
      continue;
    }
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    changes.push({ kind: changeKind(code), path });
    if (code.includes("R")) {
      index += 1;
    }
  }

  return changes;
};

export const makeGitChangeInspector = (
  worktree: string,
): ChangeInspector => ({
  inspect: () => Effect.map(inspectGitStatus(worktree), parseStatus),
});
