import { execFile } from "node:child_process";
import { Data, Effect } from "effect";
import { ChangeInspectionError } from "./workflowEngine.js";

export class GitWorktreeRequiredError extends Data.TaggedError(
  "GitWorktreeRequiredError",
)<{
  readonly message: "Auto-QA must run inside a Git worktree";
  readonly cause: unknown;
}> {}

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
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
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
