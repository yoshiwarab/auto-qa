#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { Effect } from "effect";
import { makeGitChangeInspector } from "./gitChangeInspector.js";
import { createWorkflowEngine } from "./nodeWorkflowEngine.js";
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

const success = <Result>(
  result: Result,
): SuccessEnvelope<Result> => ({
  schemaVersion: 1,
  correlationId: randomUUID(),
  ok: true,
  result,
});

const parseCommand = (argv: readonly string[]): CliCommand => {
  let command: CliCommand | undefined;
  const program = new Command()
    .name("auto-qa")
    .showHelpAfterError()
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
      const worktree = process.cwd();
      const stateDirectory = join(worktree, ".auto-qa");
      yield* Effect.tryPromise(() =>
        mkdir(stateDirectory, { recursive: true }),
      );
      const engine = yield* createWorkflowEngine({
        databasePath: join(stateDirectory, "state.db"),
        changeInspector: makeGitChangeInspector(worktree),
      });

      if (command.type === "start") {
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

const command = parseCommand(process.argv);
const envelope = await Effect.runPromise(runCommand(command));
process.stdout.write(`${JSON.stringify(envelope)}\n`);
