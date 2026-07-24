#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { Effect } from "effect";
import {
  cliFailure,
  runCliCommand,
  type CliCommand,
} from "./cliApplication.js";

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

try {
  const command = parseCommand(process.argv);
  const envelope = await Effect.runPromise(
    runCliCommand(command, process.cwd(), randomUUID),
  );
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (cause) {
  const failure = cliFailure(cause, randomUUID());
  process.stdout.write(
    `${JSON.stringify(failure.envelope)}\n`,
  );
  process.exitCode = failure.exitCode;
}
