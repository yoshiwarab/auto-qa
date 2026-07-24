#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { Data, Effect } from "effect";
import {
  findGitWorktree,
  makeGitChangeInspector,
} from "./gitChangeInspector.js";
import { RunId } from "./workflowMachine.js";

type CliCommand =
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

const failure = (
  cause: unknown,
  correlationId: string,
): FailureEnvelope => ({
  schemaVersion: 1,
  correlationId,
  ok: false,
  error: {
    code:
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      typeof cause._tag === "string"
        ? cause._tag
        : "CLI_ERROR",
    message:
      cause instanceof Error ? cause.message : "Auto-QA command failed",
  },
});

const parseCommand = (argv: readonly string[]): CliCommand => {
  let command: CliCommand | undefined;
  const program = new Command()
    .name("auto-qa")
    .showHelpAfterError()
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    })
    .exitOverride();

  program
    .command("start")
    .requiredOption("--base-url <url>")
    .action((options: { readonly baseUrl: string }) => {
      command = { type: "start", baseUrl: options.baseUrl };
    });
  program.command("job <run-id>").action((runId: string) => {
    command = { type: "job", runId };
  });
  program.command("status <run-id>").action((runId: string) => {
    command = { type: "status", runId };
  });
  program.parse(argv);

  if (command === undefined) {
    throw new Error("A command is required");
  }
  return command;
};

const runCommand = (
  command: CliCommand,
  makeId: IdGenerator,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const worktree = yield* findGitWorktree(process.cwd());
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
          try: () => fetch(baseUrl, { method: "HEAD" }),
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

try {
  const command = parseCommand(process.argv);
  const envelope = await Effect.runPromise(
    runCommand(command, randomUUID),
  );
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (cause) {
  process.stdout.write(
    `${JSON.stringify(failure(cause, randomUUID()))}\n`,
  );
  process.exitCode =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    cause.code.startsWith("commander.")
      ? 2
      : 1;
}
