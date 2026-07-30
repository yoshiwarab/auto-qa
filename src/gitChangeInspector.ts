import { execFile } from "node:child_process";
import { Data, Effect } from "effect";
import {
  ChangeInspectionError,
  type ChangeInspector,
} from "./workflowEngine.js";
import type { Change } from "./workflowProtocol.js";

export class GitWorktreeRequiredError extends Data.TaggedError(
  "GitWorktreeRequiredError",
)<{
  readonly message: "Auto-QA must run inside a Git worktree";
  readonly cause: unknown;
}> {}

const inspectGitStatus = (
  worktree: string,
): Effect.Effect<string, ChangeInspectionError> =>
  Effect.async<string, ChangeInspectionError>((resume) => {
    const child = execFile(
      "git",
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude).auto-qa",
      ],
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
    return Effect.sync(() => child.kill());
  });

export const findGitWorktree = (
  directory: string,
): Effect.Effect<
  string,
  GitWorktreeRequiredError | ChangeInspectionError
> =>
  Effect.async<
    string,
    GitWorktreeRequiredError | ChangeInspectionError
  >((resume) => {
    const child = execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: directory, encoding: "utf8" },
      (error, stdout, stderr) => {
        resume(
          error === null
            ? Effect.succeed(stdout.trim())
            : stderr.includes("not a git repository")
              ? Effect.fail(
                new GitWorktreeRequiredError({
                  message:
                    "Auto-QA must run inside a Git worktree",
                  cause: error,
                }),
                )
              : Effect.fail(
                  new ChangeInspectionError(
                    "Could not locate Git worktree",
                    error,
                  ),
                ),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

const changeKind = (status: string): string => {
  if (status === "??") {
    return "added";
  }
  if (status.includes("A")) {
    return "added";
  }
  if (status.includes("D")) {
    return "deleted";
  }
  if (status.includes("R") || status.includes("C")) {
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
    if (code.includes("R") || code.includes("C")) {
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
