import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { expect } from "vitest";
import type {
  FeatureBindings,
  StepHandler,
} from "./runtime.js";

const execFileAsync = promisify(execFile);

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type Envelope = {
  readonly schemaVersion: number;
  readonly correlationId: string;
  readonly ok: boolean;
  readonly result?: {
    readonly runId?: string;
    readonly phase: string;
    readonly job?: unknown;
    readonly reason?: string;
  };
  readonly error?: {
    readonly code: string;
    readonly details?: {
      readonly activeRunId: string;
    };
  };
};

type World = {
  readonly worktree: string;
  readonly baseUrl: URL;
  changedPath?: string;
  start?: ProcessResult;
  secondStart?: ProcessResult;
  job?: ProcessResult;
  status?: ProcessResult;
  abandon?: ProcessResult;
  newStart?: ProcessResult;
  startEnvelope?: Envelope;
  secondStartEnvelope?: Envelope;
  jobEnvelope?: Envelope;
  statusEnvelope?: Envelope;
  abandonEnvelope?: Envelope;
  newStartEnvelope?: Envelope;
};

const runGit = (
  worktree: string,
  args: readonly string[],
): Promise<void> =>
  execFileAsync("git", args, { cwd: worktree }).then(() => undefined);

const listen = (server: Server): Promise<URL> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(new URL(`http://127.0.0.1:${address.port}`));
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const makeWorld = Effect.acquireRelease(
  Effect.tryPromise(async () => {
    const parent = join(process.cwd(), "tmp");
    await mkdir(parent, { recursive: true });
    const worktree = await mkdtemp(
      join(parent, "acceptance-cli-worktree-"),
    );
    await runGit(worktree, ["init"]);
    await runGit(worktree, [
      "config",
      "user.email",
      "auto-qa@example.invalid",
    ]);
    await runGit(worktree, [
      "config",
      "user.name",
      "Auto QA Harness",
    ]);
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(
      join(worktree, "src", "dashboard.tsx"),
      "export const dashboard = 'baseline';\n",
    );
    await runGit(worktree, ["add", "."]);
    await runGit(worktree, ["commit", "-m", "Committed baseline"]);

    const targetApplication = createServer((_request, response) => {
      response.end("ok");
    });
    const baseUrl = await listen(targetApplication);
    return {
      targetApplication,
      world: { worktree, baseUrl } satisfies World,
    };
  }),
  ({ targetApplication, world }) =>
    Effect.tryPromise(async () => {
      await close(targetApplication);
      await rm(world.worktree, { recursive: true });
    }).pipe(Effect.orDie),
).pipe(Effect.map(({ world }) => world));

const exampleValue = (
  example: Readonly<Record<string, string>>,
  name: string | undefined,
): string => {
  const value = name === undefined ? undefined : example[name];
  if (value === undefined) throw new Error(`Missing example: ${name}`);
  return value;
};

const runCli = async (
  world: World,
  args: readonly string[],
): Promise<ProcessResult> => {
  try {
    const result = await execFileAsync(
      process.execPath,
      [join(process.cwd(), "dist", "src", "cli.js"), ...args],
      { cwd: join(world.worktree, "src") },
    );
    return { exitCode: 0, ...result };
  } catch (cause) {
    const failure = cause as {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      exitCode: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

const envelope = (result: ProcessResult | undefined): Envelope => {
  const stdout = result?.stdout ?? "";
  expect(stdout.endsWith("\n")).toBe(true);
  const lines = stdout.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  return JSON.parse(lines[0] ?? "null") as Envelope;
};

const startRun = async (world: World): Promise<void> => {
  world.start = await runCli(world, [
    "start",
    "--base-url",
    world.baseUrl.href,
  ]);
  world.startEnvelope = envelope(world.start);
};

const startedRunId = (world: World): string => {
  const runId = world.startEnvelope?.result?.runId;
  if (runId === undefined) throw new Error("Missing Run id");
  return runId;
};

const handlers: readonly StepHandler<World>[] = [
  {
    pattern:
      /^a harness-owned temporary Git worktree has a committed baseline$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^the file at <([A-Za-z0-9_]+)> is modified after the baseline$/,
    run: (world, example, captures) =>
      Effect.tryPromise(async () => {
        world.changedPath = exampleValue(example, captures[0]);
        await writeFile(
          join(world.worktree, world.changedPath),
          "export const dashboard = 'modified';\n",
        );
      }),
  },
  {
    pattern:
      /^a fresh CLI process starts a Run with a harness-supplied Base URL$/,
    run: (world) => Effect.tryPromise(() => startRun(world)),
  },
  {
    pattern:
      /^separate fresh CLI processes invoke the job and status commands for the returned Run$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        const runId = startedRunId(world);
        world.job = await runCli(world, ["job", runId]);
        world.status = await runCli(world, ["status", runId]);
        world.jobEnvelope = envelope(world.job);
        world.statusEnvelope = envelope(world.status);
      }),
  },
  {
    pattern: /^each process exits successfully with empty stderr$/,
    run: (world) =>
      Effect.sync(() => {
        for (const result of [world.start, world.job, world.status]) {
          expect(result).toMatchObject({ exitCode: 0, stderr: "" });
        }
      }),
  },
  {
    pattern:
      /^each stdout contains exactly one schema-version 1 JSON success envelope with a correlation id$/,
    run: (world) =>
      Effect.sync(() => {
        const values =
          world.abandonEnvelope === undefined
            ? [
                world.startEnvelope,
                world.jobEnvelope,
                world.statusEnvelope,
              ]
            : [
                world.abandonEnvelope,
                world.statusEnvelope,
                world.newStartEnvelope,
              ];
        for (const value of values) {
          expect(value).toMatchObject({
            schemaVersion: 1,
            correlationId: expect.any(String),
            ok: true,
          });
          expect(value?.correlationId.length).toBeGreaterThan(0);
        }
      }),
  },
  {
    pattern:
      /^the start and Job envelopes contain the same schema-version 1 generate-plan Job$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.jobEnvelope?.result?.job).toEqual(
          world.startEnvelope?.result?.job,
        );
        expect(world.startEnvelope?.result?.job).toMatchObject({
          schemaVersion: 1,
          type: "generate-plan",
          payload: { baseUrl: world.baseUrl.href },
        });
      }),
  },
  {
    pattern:
      /^the generate-plan Job contains a <([A-Za-z0-9_]+)> change at <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.startEnvelope?.result?.job).toMatchObject({
          payload: {
            changes: [
              {
                kind: exampleValue(example, captures[0]),
                path: exampleValue(example, captures[1]),
              },
            ],
          },
        });
      }),
  },
  {
    pattern:
      /^the start and status envelopes report phase awaitingAgent$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.startEnvelope?.result?.phase).toBe("awaitingAgent");
        expect(world.statusEnvelope?.result?.phase).toBe(
          "awaitingAgent",
        );
      }),
  },
  {
    pattern:
      /^a fresh CLI process starts the first Run with a harness-supplied Base URL$/,
    run: (world) => Effect.tryPromise(() => startRun(world)),
  },
  {
    pattern:
      /^another fresh CLI process attempts to start a second Run in the same worktree with the same Base URL$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        world.secondStart = await runCli(world, [
          "start",
          "--base-url",
          world.baseUrl.href,
        ]);
        world.secondStartEnvelope = envelope(world.secondStart);
      }),
  },
  {
    pattern: /^the first process exits successfully with empty stderr$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.start).toMatchObject({
          exitCode: 0,
          stderr: "",
        });
      }),
  },
  {
    pattern:
      /^the second process exits with code <([A-Za-z0-9_]+)> and empty stderr$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.secondStart).toMatchObject({
          exitCode: Number(exampleValue(example, captures[0])),
          stderr: "",
        });
      }),
  },
  {
    pattern:
      /^the second stdout contains exactly one schema-version 1 JSON failure envelope with a correlation id$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.secondStartEnvelope).toMatchObject({
          schemaVersion: 1,
          correlationId: expect.any(String),
          ok: false,
        });
        expect(
          world.secondStartEnvelope?.correlationId.length,
        ).toBeGreaterThan(0);
      }),
  },
  {
    pattern: /^the failure code is <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.secondStartEnvelope?.error?.code).toBe(
          exampleValue(example, captures[0]),
        );
      }),
  },
  {
    pattern:
      /^the failure identifies the first Run by its returned Run id$/,
    run: (world) =>
      Effect.sync(() => {
        expect(
          world.secondStartEnvelope?.error?.details?.activeRunId,
        ).toBe(world.startEnvelope?.result?.runId);
      }),
  },
  {
    pattern:
      /^a fresh status process reports the first Run in phase <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.tryPromise(async () => {
        const runId = startedRunId(world);
        world.status = await runCli(world, ["status", runId]);
        world.statusEnvelope = envelope(world.status);
        expect(world.status).toMatchObject({
          exitCode: 0,
          stderr: "",
        });
        expect(world.statusEnvelope?.result?.phase).toBe(
          exampleValue(example, captures[0]),
        );
      }),
  },
  {
    pattern:
      /^a fresh CLI process has started the first Run with a harness-supplied Base URL$/,
    run: (world) => Effect.tryPromise(() => startRun(world)),
  },
  {
    pattern:
      /^another fresh CLI process invokes runs abandon for the first Run with reason <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.tryPromise(async () => {
        const runId = startedRunId(world);
        world.abandon = await runCli(world, [
          "runs",
          "abandon",
          runId,
          "--reason",
          exampleValue(example, captures[0]),
        ]);
        world.abandonEnvelope = envelope(world.abandon);
      }),
  },
  {
    pattern: /^a fresh status process reads the first Run$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        const runId = startedRunId(world);
        world.status = await runCli(world, ["status", runId]);
        world.statusEnvelope = envelope(world.status);
      }),
  },
  {
    pattern:
      /^a fresh CLI process starts another Run in the same worktree with the same Base URL$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        world.newStart = await runCli(world, [
          "start",
          "--base-url",
          world.baseUrl.href,
        ]);
        world.newStartEnvelope = envelope(world.newStart);
      }),
  },
  {
    pattern:
      /^the abandon, status, and new start processes each exit successfully with empty stderr$/,
    run: (world) =>
      Effect.sync(() => {
        for (const result of [
          world.abandon,
          world.status,
          world.newStart,
        ]) {
          expect(result).toMatchObject({ exitCode: 0, stderr: "" });
        }
      }),
  },
  {
    pattern:
      /^the status envelope reports the first Run in phase <([A-Za-z0-9_]+)> with reason <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.statusEnvelope?.result).toMatchObject({
          phase: exampleValue(example, captures[0]),
          reason: exampleValue(example, captures[1]),
        });
      }),
  },
  {
    pattern:
      /^the new start envelope reports a different Run in phase awaitingAgent$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.newStartEnvelope?.result).toMatchObject({
          phase: "awaitingAgent",
          runId: expect.any(String),
        });
        expect(world.newStartEnvelope?.result?.runId).not.toBe(
          world.startEnvelope?.result?.runId,
        );
      }),
  },
];

export const cliDurableGeneratePlanHandoff: FeatureBindings<World> = {
  makeWorld,
  handlers,
};
