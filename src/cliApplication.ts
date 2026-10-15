import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { cliSuccess } from "./cliProtocol.js";
import { makeGitChangeInspector } from "./gitChangeInspector.js";
import { findGitWorktree } from "./gitWorktree.js";
import { RunId } from "./workflowMachine.js";

export type CliCommand =
  | { readonly type: "cleanup" }
  | {
      readonly type: "start";
      readonly baseUrl: string;
    }
  | {
      readonly type: "job" | "status";
      readonly runId: string;
    }
  | {
      readonly type: "abandon";
      readonly runId: string;
      readonly reason: string;
    }
  | {
      readonly type: "submit";
      readonly runId: string;
      readonly jobId: string;
      readonly file: string;
    };

class CliBoundaryError extends Data.TaggedError("CliBoundaryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type IdGenerator = () => string;

export const runCliCommand = (
  command: CliCommand,
  currentDirectory: string,
  makeId: IdGenerator
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const worktree = yield* findGitWorktree(currentDirectory);
      const stateDirectory = join(worktree, ".auto-qa");
      const isReadOnly = command.type === "job" || command.type === "status";
      if (!isReadOnly) {
        yield* Effect.tryPromise({
          try: () => mkdir(stateDirectory, { recursive: true }),
          catch: (cause) =>
            new CliBoundaryError({
              operation: "create state directory",
              cause,
            }),
        });
      }
      const { createWorkflowEngine } = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const emitWarning = process.emitWarning;
          process.emitWarning = () => undefined;
          return emitWarning;
        }),
        () => Effect.promise(() => import("./nodeWorkflowEngine.js")),
        (emitWarning) =>
          Effect.sync(() => {
            process.emitWarning = emitWarning;
          })
      );
      const engine = yield* createWorkflowEngine({
        databasePath: join(stateDirectory, "state.db"),
        changeInspector: makeGitChangeInspector(worktree),
        readOnly: isReadOnly,
      });

      if (command.type === "start") {
        const baseUrl = yield* Effect.try({
          try: () => new URL(command.baseUrl),
          catch: (cause) =>
            new CliBoundaryError({
              operation: "parse Base URL",
              cause,
            }),
        });
        yield* Effect.tryPromise({
          try: (signal) => fetch(baseUrl, { method: "HEAD", signal }),
          catch: (cause) =>
            new CliBoundaryError({
              operation: "reach Target Application",
              cause,
            }),
        });
        const runId = RunId(makeId());
        const result = yield* engine.dispatch(runId, {
          type: "start",
          baseUrl,
        });
        return cliSuccess(
          {
            runId,
            phase: result.phase,
            job: result.pendingJob,
          },
          makeId()
        );
      }

      if (command.type === "cleanup") {
        yield* engine.cleanup();
        return cliSuccess({ status: "clean" }, makeId());
      }

      const runId = RunId(command.runId);
      if (command.type === "abandon") {
        const status = yield* engine.dispatch(runId, {
          type: "abandon",
          reason: command.reason,
        });
        return cliSuccess(status, makeId());
      }
      if (command.type === "submit") {
        const payload = yield* Effect.tryPromise({
          try: async () =>
            JSON.parse(await readFile(command.file, "utf8")) as unknown,
          catch: (cause) =>
            new CliBoundaryError({
              operation: "read Job submission",
              cause,
            }),
        });
        const result = yield* engine.dispatch(runId, {
          type: "submitJob",
          jobId: command.jobId,
          payload,
        });
        return cliSuccess(result, makeId());
      }
      if (command.type === "job") {
        const [status, job] = yield* Effect.all([
          engine.getStatus(runId),
          engine.getPendingJob(runId),
        ]);
        return cliSuccess({ phase: status.phase, job }, makeId());
      }

      const status = yield* engine.getStatus(runId);
      return cliSuccess(
        {
          phase: status.phase,
          ...(status.outcome === undefined
            ? {}
            : {
                outcome: status.outcome,
                attempts: status.attempts,
                classifications: status.classifications,
                coverageIncomplete: status.coverageIncomplete,
                incompleteScenarios: status.incompleteScenarios,
              }),
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        },
        makeId()
      );
    })
  );
