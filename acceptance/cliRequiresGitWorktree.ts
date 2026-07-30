import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { expect } from "vitest";
import type {
  FeatureBindings,
  StepHandler,
} from "./runtime.js";
import { makeTargetApplicationHarness } from "./targetApplicationHarness.js";

const execFileAsync = promisify(execFile);

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type FailureEnvelope = {
  readonly schemaVersion: number;
  readonly correlationId: string;
  readonly ok: boolean;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
};

type World = {
  readonly directory: string;
  readonly baseUrl: URL;
  processResult?: ProcessResult;
  envelope?: FailureEnvelope;
};

const makeWorld = makeTargetApplicationHarness(
  "acceptance-non-git-",
).pipe(
  Effect.map(
    ({ directory, baseUrl }): World => ({ directory, baseUrl }),
  ),
);

const exampleValue = (
  example: Readonly<Record<string, string>>,
  name: string | undefined,
): string => {
  const value = name === undefined ? undefined : example[name];
  if (value === undefined) throw new Error(`Missing example: ${name}`);
  return value;
};

const parseEnvelope = (stdout: string): FailureEnvelope => {
  expect(stdout.endsWith("\n")).toBe(true);
  const lines = stdout.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  return JSON.parse(lines[0] ?? "null") as FailureEnvelope;
};

const handlers: readonly StepHandler<World>[] = [
  {
    pattern:
      /^a harness-owned temporary directory is outside every Git worktree$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^a fresh CLI process invokes start with a harness-supplied Base URL from that directory$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        try {
          const result = await execFileAsync(
            process.execPath,
            [
              join(process.cwd(), "dist", "src", "cli.js"),
              "start",
              "--base-url",
              world.baseUrl.href,
            ],
            {
              cwd: world.directory,
              env: {
                ...process.env,
                GIT_CEILING_DIRECTORIES: process.cwd(),
              },
            },
          );
          world.processResult = { exitCode: 0, ...result };
        } catch (cause) {
          const failure = cause as {
            readonly code?: number;
            readonly stdout?: string;
            readonly stderr?: string;
          };
          world.processResult = {
            exitCode: failure.code ?? 1,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
          };
        }
        world.envelope = parseEnvelope(
          world.processResult.stdout,
        );
      }),
  },
  {
    pattern:
      /^the process exits with code <([A-Za-z0-9_]+)> and empty stderr$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.processResult).toMatchObject({
          exitCode: Number(exampleValue(example, captures[0])),
          stderr: "",
        });
      }),
  },
  {
    pattern:
      /^stdout contains exactly one schema-version 1 JSON failure envelope with a correlation id$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.envelope).toMatchObject({
          schemaVersion: 1,
          correlationId: expect.any(String),
          ok: false,
        });
        expect(world.envelope?.correlationId.length).toBeGreaterThan(
          0,
        );
      }),
  },
  {
    pattern: /^the failure code is <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.envelope?.error.code).toBe(
          exampleValue(example, captures[0]),
        );
      }),
  },
  {
    pattern: /^the failure message is <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.envelope?.error.message).toBe(
          exampleValue(example, captures[0]),
        );
      }),
  },
  {
    pattern:
      /^no \.auto-qa directory exists beneath the temporary directory$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        await expect(
          access(join(world.directory, ".auto-qa")).then(
            () => true,
            () => false,
          ),
        ).resolves.toBe(false);
      }),
  },
];

export const cliRequiresGitWorktree: FeatureBindings<World> = {
  makeWorld,
  handlers,
};
