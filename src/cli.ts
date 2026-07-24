#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { Effect } from "effect";
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

const success = <Result>(
  result: Result,
): SuccessEnvelope<Result> => ({
  schemaVersion: 1,
  correlationId: randomUUID(),
  ok: true,
  result,
});

const failure = (cause: unknown): FailureEnvelope => ({
  schemaVersion: 1,
  correlationId: randomUUID(),
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
): Effect.Effect<unknown, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const worktree = yield* findGitWorktree(process.cwd());
      const stateDirectory = join(worktree, ".auto-qa");
      const isReadOnly = command.type !== "start";
      if (!isReadOnly) {
        yield* Effect.tryPromise(() =>
          mkdir(stateDirectory, { recursive: true }),
        );
      }
      const emitWarning = process.emitWarning;
      process.emitWarning = () => undefined;
      const { createWorkflowEngine } = yield* Effect.promise(() =>
        import("./nodeWorkflowEngine.js"),
      );
      process.emitWarning = emitWarning;
      const engine = yield* createWorkflowEngine({
        databasePath: join(stateDirectory, "state.db"),
        changeInspector: makeGitChangeInspector(worktree),
        readOnly: isReadOnly,
      });

      if (command.type === "start") {
        yield* Effect.tryPromise(() =>
          fetch(new URL(command.baseUrl), { method: "HEAD" }),
        );
        const runId = RunId(randomUUID());
        const result = yield* engine.dispatch(runId, {
          type: "start",
          baseUrl: new URL(command.baseUrl),
        });
        return success({
          runId,
          phase: result.phase,
          job: result.pendingJob,
        });
      }

      const runId = RunId(command.runId);
      if (command.type === "job") {
        const [status, job] = yield* Effect.all([
          engine.getStatus(runId),
          engine.getPendingJob(runId),
        ]);
        return success({ phase: status.phase, job });
      }

      const status = yield* engine.getStatus(runId);
      return success({ phase: status.phase });
    }),
  );

try {
  const command = parseCommand(process.argv);
  const envelope = await Effect.runPromise(runCommand(command));
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (cause) {
  process.stdout.write(`${JSON.stringify(failure(cause))}\n`);
  process.exitCode =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    cause.code.startsWith("commander.")
      ? 2
      : 1;
}
