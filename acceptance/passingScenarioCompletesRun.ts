import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { chromium } from "playwright";
import { expect } from "vitest";
import {
  parseOnlyJsonLine,
  runCliProcess,
  type ProcessResult,
} from "./cliProcessHarness.js";
import {
  makeQaLab,
  type QaLabProcess,
} from "./qaLabHarness.js";
import {
  exampleValue,
  type FeatureBindings,
  type StepHandler,
} from "./runtime.js";

const execFileAsync = promisify(execFile);

type Attempt = {
  readonly scenarioId: string;
  readonly attemptNumber: number;
  readonly scriptVersion: number;
  readonly status: string;
};

type Envelope = {
  readonly ok: boolean;
  readonly result: {
    readonly runId?: string;
    readonly phase: string;
    readonly outcome?: string;
    readonly job?: { readonly id: string } | null;
    readonly attempts?: readonly Attempt[];
  };
};

type World = {
  readonly worktree: string;
  readonly baseUrl: URL;
  readonly targetApplication: QaLabProcess;
  readonly submissionPath: string;
  scenarioId?: string;
  script?: string;
  start?: ProcessResult;
  submit?: ProcessResult;
  job?: ProcessResult;
  status?: ProcessResult;
  startEnvelope?: Envelope;
  submitEnvelope?: Envelope;
  jobEnvelope?: Envelope;
  statusEnvelope?: Envelope;
};

const runGit = (
  cwd: string,
  args: readonly string[],
): Promise<void> =>
  execFileAsync("git", args, { cwd }).then(() => undefined);

const makeWorld = Effect.gen(function* () {
  const targetApplication = yield* makeQaLab(process.cwd());
  return yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const parent = join(process.cwd(), "tmp");
      await mkdir(parent, { recursive: true });
      const worktree = await mkdtemp(
        join(parent, "acceptance-passing-browser-"),
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
      await writeFile(
        join(worktree, "account.tsx"),
        "export const heading = 'Baseline';\n",
      );
      await runGit(worktree, ["add", "."]);
      await runGit(worktree, [
        "commit",
        "-m",
        "Committed baseline",
      ]);
      await writeFile(
        join(worktree, "account.tsx"),
        "export const heading = 'Account';\n",
      );
      const planDirectory = await mkdtemp(
        join(parent, "acceptance-plan-"),
      );

      const world = {
        worktree,
        targetApplication,
        baseUrl: targetApplication.baseUrl,
        submissionPath: join(planDirectory, "submission.json"),
      } satisfies World;
      return world;
    }),
    (world) =>
      Effect.tryPromise(async () => {
        await Promise.all([
          rm(world.worktree, { recursive: true }),
          rm(dirname(world.submissionPath), {
            recursive: true,
          }),
        ]);
      }).pipe(Effect.orDie),
  );
});

const runCli = (
  world: World,
  args: readonly string[],
): Promise<ProcessResult> =>
  runCliProcess({
    cwd: world.worktree,
    args,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: join(
        process.cwd(),
        "tmp",
        "playwright-browsers",
      ),
    },
  });

const runId = (world: World): string => {
  const value = world.startEnvelope?.result.runId;
  if (value === undefined) throw new Error("Missing Run id");
  return value;
};

const ownedBrowserProcesses = async (): Promise<readonly string[]> => {
  const { stdout } = await execFileAsync("ps", [
    "-eo",
    "pid=,args=",
  ]);
  const browserRoot = join(
    process.cwd(),
    "tmp",
    "playwright-browsers",
  );
  return stdout
    .split("\n")
    .filter((line) => line.includes(browserRoot));
};

const handlers: readonly StepHandler<World>[] = [
  {
    pattern:
      /^a harness-owned temporary Git worktree has a committed baseline and one frontend change$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^a harness-owned Target Application serves accessible heading <([A-Za-z0-9_]+)> at a harness-supplied Base URL$/,
    run: (world, example, captures) =>
      Effect.tryPromise(async () => {
        const expectedHeading = exampleValue(
          example,
          captures[0],
        );
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(world.baseUrl.href);
          expect(
            await page
              .getByRole("heading", {
                name: expectedHeading,
                exact: true,
              })
              .count(),
          ).toBe(1);
        } finally {
          await browser.close();
        }
      }),
  },
  {
    pattern:
      /^a fresh CLI process starts a Run with that Base URL$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        world.start = await runCli(world, [
          "start",
          "--base-url",
          world.baseUrl.href,
        ]);
        world.startEnvelope =
          parseOnlyJsonLine<Envelope>(world.start);
      }),
  },
  {
    pattern:
      /^a generate-plan submission for the returned Job contains one non-mutating Scenario <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        world.scenarioId = exampleValue(example, captures[0]);
      }),
  },
  {
    pattern:
      /^its Scenario Script opens the injected Base URL and expects accessible heading <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        const heading = exampleValue(example, captures[0]);
        world.script = `async ({ page, baseUrl, expect }) => { await page.goto(baseUrl.href); await expect(page.getByRole('heading', { name: '${heading}', exact: true })).toBeVisible(); }`;
      }),
  },
  {
    pattern: /^another fresh CLI process submits that plan$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        const scenarioId = world.scenarioId;
        const script = world.script;
        const job = world.startEnvelope?.result.job;
        if (
          scenarioId === undefined ||
          script === undefined ||
          job == null
        ) {
          throw new Error("Incomplete generate-plan submission");
        }
        await writeFile(
          world.submissionPath,
          JSON.stringify({
            schemaVersion: 1,
            scenarios: [
              {
                id: scenarioId,
                goal: `Verify ${scenarioId}`,
                preconditions: [],
                mutates: false,
                script,
              },
            ],
          }),
        );
        world.submit = await runCli(world, [
          "submit",
          runId(world),
          "--job-id",
          job.id,
          "--file",
          world.submissionPath,
        ]);
        world.submitEnvelope =
          parseOnlyJsonLine<Envelope>(world.submit);
      }),
  },
  {
    pattern: /^the submit process exits successfully$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.submit).toMatchObject({
          exitCode: 0,
          stderr: "",
        });
        expect(world.submitEnvelope?.ok).toBe(true);
      }),
  },
  {
    pattern:
      /^fresh job and status processes report no pending Job and phase <([A-Za-z0-9_]+)> with Run Outcome <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.tryPromise(async () => {
        world.job = await runCli(world, ["job", runId(world)]);
        world.status = await runCli(world, [
          "status",
          runId(world),
        ]);
        world.jobEnvelope =
          parseOnlyJsonLine<Envelope>(world.job);
        world.statusEnvelope =
          parseOnlyJsonLine<Envelope>(world.status);
        expect([world.job, world.status]).toEqual([
          expect.objectContaining({ exitCode: 0, stderr: "" }),
          expect.objectContaining({ exitCode: 0, stderr: "" }),
        ]);
        expect(world.jobEnvelope?.result).toMatchObject({
          phase: exampleValue(example, captures[0]),
          job: null,
        });
        expect(world.statusEnvelope?.result).toMatchObject({
          phase: exampleValue(example, captures[0]),
          outcome: exampleValue(example, captures[1]),
        });
      }),
  },
  {
    pattern:
      /^Scenario <([A-Za-z0-9_]+)> has exactly one Attempt numbered <([A-Za-z0-9_]+)> using Script Version <([A-Za-z0-9_]+)> with status <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.statusEnvelope?.result.attempts).toEqual([
          {
            scenarioId: exampleValue(example, captures[0]),
            attemptNumber: Number(
              exampleValue(example, captures[1]),
            ),
            scriptVersion: Number(
              exampleValue(example, captures[2]),
            ),
            status: exampleValue(example, captures[3]),
            evidencePath: expect.any(String),
          },
        ]);
      }),
  },
  {
    pattern:
      /^the finalized Evidence Bundle contains a schema-version <([A-Za-z0-9_]+)> manifest listing result\.json$/,
    run: (world, example, captures) =>
      Effect.tryPromise(async () => {
        const attemptDirectory = join(
          world.worktree,
          ".auto-qa",
          "runs",
          runId(world),
          "scenarios",
          world.scenarioId ?? "",
          "attempt-1",
        );
        expect(
          JSON.parse(
            await readFile(
              join(attemptDirectory, "manifest.json"),
              "utf8",
            ),
          ),
        ).toEqual({
          schemaVersion: Number(
            exampleValue(example, captures[0]),
          ),
          files: ["result.json"],
        });
      }),
  },
  {
    pattern:
      /^result\.json identifies Scenario <([A-Za-z0-9_]+)>, Attempt <([A-Za-z0-9_]+)>, Script Version <([A-Za-z0-9_]+)>, and status <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.tryPromise(async () => {
        const result = JSON.parse(
          await readFile(
            join(
              world.worktree,
              ".auto-qa",
              "runs",
              runId(world),
              "scenarios",
              exampleValue(example, captures[0]),
              "attempt-1",
              "result.json",
            ),
            "utf8",
          ),
        );
        expect(result).toMatchObject({
          scenarioId: exampleValue(example, captures[0]),
          attemptNumber: Number(
            exampleValue(example, captures[1]),
          ),
          scriptVersion: Number(
            exampleValue(example, captures[2]),
          ),
          status: exampleValue(example, captures[3]),
        });
      }),
  },
  {
    pattern:
      /^report\.md identifies Run Outcome <([A-Za-z0-9_]+)> and the passing Attempt$/,
    run: (world, example, captures) =>
      Effect.tryPromise(async () => {
        const report = await readFile(
          join(
            world.worktree,
            ".auto-qa",
            "runs",
            runId(world),
            "report.md",
          ),
          "utf8",
        );
        expect(report).toContain(
          `Run Outcome: ${exampleValue(example, captures[0])}`,
        );
        expect(report).toContain(
          `${world.scenarioId}: Attempt 1, Script Version 0, passed`,
        );
      }),
  },
  {
    pattern:
      /^no temporary Evidence Bundle, registered browser resource, browser, context, or child process owned by Auto-QA remains$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        await expect(
          readdir(
            join(
              world.worktree,
              ".auto-qa",
              "runs",
              runId(world),
              "scenarios",
              world.scenarioId ?? "",
            ),
          ),
        ).resolves.toEqual(["attempt-1"]);
        await expect(
          access(
            join(
              world.worktree,
              ".auto-qa",
              "registry.json",
            ),
          ),
        ).rejects.toThrow();
        await expect(ownedBrowserProcesses()).resolves.toEqual([]);
      }),
  },
  {
    pattern:
      /^the harness-owned Target Application remains running$/,
    run: (world) =>
      Effect.tryPromise(async () => {
        expect(world.targetApplication.isRunning()).toBe(true);
        await expect(
          fetch(world.baseUrl).then((response) => response.ok),
        ).resolves.toBe(true);
      }),
  },
];

export const passingScenarioCompletesRun: FeatureBindings<World> = {
  makeWorld,
  handlers,
};
