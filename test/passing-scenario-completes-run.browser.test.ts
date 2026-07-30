import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "vitest";
import {
  startQaLab,
  type QaLabProcess,
} from "../acceptance/qaLabHarness.js";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const cliPath = process.env["AUTO_QA_PACKED_CLI"];
if (cliPath === undefined) {
  throw new Error(
    "AUTO_QA_PACKED_CLI must identify the packed CLI under test",
  );
}
const temporaryDirectories: string[] = [];
let targetApplication: QaLabProcess | undefined;
let baseUrl: URL;

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = async (
  worktree: string,
  args: readonly string[],
  secretCanary: string,
): Promise<ProcessResult> => {
  try {
    const result = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      {
        cwd: worktree,
        env: {
          ...process.env,
          AUTO_QA_SECRET_CANARY: secretCanary,
          PLAYWRIGHT_BROWSERS_PATH: join(
            projectRoot,
            "tmp",
            "playwright-browsers",
          ),
        },
      },
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

const parseEnvelope = (result: ProcessResult) => {
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.split("\n")).toHaveLength(2);
  return JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly result: {
      readonly runId: string;
      readonly phase: string;
      readonly outcome?: string;
      readonly job?: {
        readonly id: string;
      } | null;
      readonly attempts?: readonly {
        readonly scenarioId: string;
        readonly attemptNumber: number;
        readonly scriptVersion: number;
        readonly status: string;
      }[];
    };
  };
};

const ownedBrowserProcesses = async (): Promise<readonly string[]> => {
  const { stdout } = await execFileAsync("ps", [
    "-eo",
    "pid=,args=",
  ]);
  const browserRoot = join(
    projectRoot,
    "tmp",
    "playwright-browsers",
  );
  return stdout
    .split("\n")
    .filter((line) => line.includes(browserRoot));
};

const makeChangedWorktree = async (): Promise<string> => {
  const parent = join(projectRoot, "tmp");
  await mkdir(parent, { recursive: true });
  const worktree = await mkdtemp(join(parent, "browser-worktree-"));
  temporaryDirectories.push(worktree);
  await execFileAsync("git", ["init"], { cwd: worktree });
  await execFileAsync(
    "git",
    ["config", "user.email", "auto-qa@example.invalid"],
    { cwd: worktree },
  );
  await execFileAsync(
    "git",
    ["config", "user.name", "Auto QA Harness"],
    { cwd: worktree },
  );
  await writeFile(
    join(worktree, "account.tsx"),
    "export const heading = 'Baseline';\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: worktree });
  await execFileAsync(
    "git",
    ["commit", "-m", "Committed baseline"],
    { cwd: worktree },
  );
  await writeFile(
    join(worktree, "account.tsx"),
    "export const heading = 'Account';\n",
  );
  return worktree;
};

beforeAll(async () => {
  targetApplication = await startQaLab(projectRoot);
  baseUrl = targetApplication.baseUrl;
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true }),
    ),
  );
});

afterAll(async () => {
  await targetApplication?.stop();
});

test(
  "one passing Scenario completes the Run with durable evidence",
  async () => {
    const worktree = await makeChangedWorktree();
    const secretCanary = `auto-qa-secret-canary-${randomUUID()}`;
    const processOutput: string[] = [];
    const start = await runCli(worktree, [
      "start",
      "--base-url",
      baseUrl.href,
    ], secretCanary);
    processOutput.push(start.stdout, start.stderr);
    const started = parseEnvelope(start);
    expect(start).toMatchObject({ exitCode: 0 });
    const job = started.result.job;
    expect(job).not.toBeNull();
    expect(job).toBeDefined();

    const submissionPath = join(
      projectRoot,
      "tmp",
      `passing-plan-${started.result.runId}.json`,
    );
    await writeFile(
      submissionPath,
      JSON.stringify({
        schemaVersion: 1,
        scenarios: [
          {
            id: "account-loads",
            goal: "The account page is accessible",
            preconditions: [],
            mutates: false,
            script:
              "async ({ page, baseUrl, expect }) => { await page.goto(baseUrl.href); await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible(); }",
          },
        ],
      }),
    );
    temporaryDirectories.push(submissionPath);

    const submit = await runCli(worktree, [
      "submit",
      started.result.runId,
      "--job-id",
      job?.id ?? "",
      "--file",
      submissionPath,
    ], secretCanary);
    processOutput.push(submit.stdout, submit.stderr);
    const submitted = parseEnvelope(submit);
    expect(submit, submit.stdout).toMatchObject({ exitCode: 0 });
    expect(submitted.result).toMatchObject({
      phase: "completed",
      outcome: "passed",
      attempts: [
        {
          scenarioId: "account-loads",
          attemptNumber: 1,
          scriptVersion: 0,
          status: "passed",
        },
      ],
    });

    const jobStatus = await runCli(
      worktree,
      ["job", started.result.runId],
      secretCanary,
    );
    processOutput.push(jobStatus.stdout, jobStatus.stderr);
    const observedJob = parseEnvelope(jobStatus);
    const runStatus = await runCli(
      worktree,
      ["status", started.result.runId],
      secretCanary,
    );
    processOutput.push(runStatus.stdout, runStatus.stderr);
    const observedStatus = parseEnvelope(runStatus);
    expect(observedJob.result).toMatchObject({
      phase: "completed",
      job: null,
    });
    expect(observedStatus.result).toMatchObject({
      phase: "completed",
      outcome: "passed",
      attempts: submitted.result.attempts,
    });

    const runDirectory = join(
      worktree,
      ".auto-qa",
      "runs",
      started.result.runId,
    );
    const attemptDirectory = join(
      runDirectory,
      "scenarios",
      "account-loads",
      "attempt-1",
    );
    const manifestText = await readFile(
      join(attemptDirectory, "manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(manifestText);
    expect(manifest).toEqual({
      schemaVersion: 1,
      files: ["result.json"],
    });
    const resultText = await readFile(
      join(attemptDirectory, "result.json"),
      "utf8",
    );
    const result = JSON.parse(resultText);
    expect(result).toMatchObject({
      scenarioId: "account-loads",
      attemptNumber: 1,
      scriptVersion: 0,
      status: "passed",
    });
    await expect(
      readdir(join(runDirectory, "scenarios", "account-loads")),
    ).resolves.toEqual(["attempt-1"]);
    const reportText = await readFile(
      join(runDirectory, "report.md"),
      "utf8",
    );
    expect(reportText).toContain(
      "Run Outcome: passed\n\n- account-loads: Attempt 1, Script Version 0, passed",
    );
    const persistedState = await readFile(
      join(worktree, ".auto-qa", "state.db"),
    );
    expect(
      [
        ...processOutput,
        manifestText,
        resultText,
        reportText,
        persistedState.toString("utf8"),
      ].join("\n"),
    ).not.toContain(secretCanary);
    await expect(
      access(join(worktree, ".auto-qa", "registry.json")),
    ).rejects.toThrow();
    await expect(ownedBrowserProcesses()).resolves.toEqual([]);

    expect(targetApplication?.isRunning()).toBe(true);
    await expect(fetch(baseUrl).then((response) => response.text()))
      .resolves.toContain("Account");
  },
  30_000,
);
