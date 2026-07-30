import { access } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  parseOnlyJsonLine,
  runCliProcess,
  type ProcessResult,
} from "./cliProcessHarness.js";
import {
  exampleValue,
  type FeatureBindings,
  type StepHandler,
} from "./runtime.js";
import { makeTargetApplicationHarness } from "./targetApplicationHarness.js";

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
  readonly getRequestCount: () => number;
  processResult?: ProcessResult;
  envelope?: FailureEnvelope;
};

const makeWorld = makeTargetApplicationHarness(
  "acceptance-non-git-",
).pipe(
  Effect.map(
    ({ directory, baseUrl, getRequestCount }): World => ({
      directory,
      baseUrl,
      getRequestCount,
    }),
  ),
);

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
        world.processResult = await runCliProcess({
          cwd: world.directory,
          args: [
            "start",
            "--base-url",
            world.baseUrl.href,
          ],
          env: {
            ...process.env,
            GIT_CEILING_DIRECTORIES: process.cwd(),
          },
        });
        world.envelope =
          parseOnlyJsonLine<FailureEnvelope>(world.processResult);
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
        expect(world.getRequestCount()).toBe(0);
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
