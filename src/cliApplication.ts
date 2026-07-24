import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import {
  findGitWorktree,
  makeGitChangeInspector,
} from "./gitChangeInspector.js";
import { RunId } from "./workflowMachine.js";

export type CliCommand =
  | {
      readonly type: "start";
      readonly baseUrl: string;
    }
  | {
      readonly type: "job" | "status";
      readonly runId: string;
    };

type SuccessEnvelope<Result> = {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly ok: true;
  readonly result: Result;
};

type FailureEnvelope = {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
};

class CliBoundaryError extends Data.TaggedError("CliBoundaryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type IdGenerator = () => string;

const success = <Result>(
  result: Result,
  correlationId: string,
): SuccessEnvelope<Result> => ({
  schemaVersion: 1,
  correlationId,
  ok: true,
  result,
});

const failureMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim() !== "") {
    return cause.message;
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "operation" in cause &&
    typeof cause.operation === "string"
  ) {
    return `Auto-QA failed during ${cause.operation}`;
  }
  return "Auto-QA command failed";
};

const failureCode = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null) {
    return "CLI_ERROR";
  }
  if ("_tag" in cause && typeof cause._tag === "string") {
    return cause._tag;
  }
  if ("code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return "CLI_ERROR";
};

export const cliFailure = (
  cause: unknown,
  correlationId: string,
): {
  readonly envelope: FailureEnvelope;
  readonly exitCode: number;
} => {
  const code = failureCode(cause);
  return {
    envelope: {
      schemaVersion: 1,
      correlationId,
      ok: false,
      error: {
        code,
        message: failureMessage(cause),
      },
    },
    exitCode: code.startsWith("commander.") ? 2 : 1,
  };
};

export const runCliCommand = (
  command: CliCommand,
  currentDirectory: string,
  makeId: IdGenerator,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const worktree = yield* findGitWorktree(currentDirectory);
      const stateDirectory = join(worktree, ".auto-qa");
      const isReadOnly = command.type !== "start";
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
          }),
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
          try: (signal) =>
            fetch(baseUrl, { method: "HEAD", signal }),
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
        return success({
          runId,
          phase: result.phase,
          job: result.pendingJob,
        }, makeId());
      }

      const runId = RunId(command.runId);
      if (command.type === "job") {
        const [status, job] = yield* Effect.all([
          engine.getStatus(runId),
          engine.getPendingJob(runId),
        ]);
        return success({ phase: status.phase, job }, makeId());
      }

      const status = yield* engine.getStatus(runId);
      return success({ phase: status.phase }, makeId());
    }),
  );
