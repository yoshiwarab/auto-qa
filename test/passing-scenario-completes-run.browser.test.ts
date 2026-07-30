import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "src", "cli.js");
const temporaryDirectories: string[] = [];
let targetApplication: Server;
let baseUrl: URL;

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = async (
  worktree: string,
  args: readonly string[],
): Promise<ProcessResult> => {
  try {
    const result = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      {
        cwd: worktree,
        env: {
          ...process.env,
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
  targetApplication = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<main><h1>Account</h1></main>");
  });
  await new Promise<void>((resolve) => {
    targetApplication.listen(0, "127.0.0.1", resolve);
  });
  const address = targetApplication.address() as AddressInfo;
  baseUrl = new URL(`http://127.0.0.1:${address.port}`);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true }),
    ),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    targetApplication.close((cause) => {
      if (cause) reject(cause);
      else resolve();
    });
  });
});

test(
  "one passing Scenario completes the Run with durable evidence",
  async () => {
    const worktree = await makeChangedWorktree();
    const start = await runCli(worktree, [
      "start",
      "--base-url",
      baseUrl.href,
    ]);
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
    ]);
    const submitted = parseEnvelope(submit);
    expect(submit).toMatchObject({ exitCode: 0 });
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

    const observedJob = parseEnvelope(
      await runCli(worktree, [
        "job",
        started.result.runId,
      ]),
    );
    const observedStatus = parseEnvelope(
      await runCli(worktree, [
        "status",
        started.result.runId,
      ]),
    );
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
    const manifest = JSON.parse(
      await readFile(join(attemptDirectory, "manifest.json"), "utf8"),
    );
    expect(manifest).toEqual({
      schemaVersion: 1,
      files: ["result.json"],
    });
    const result = JSON.parse(
      await readFile(join(attemptDirectory, "result.json"), "utf8"),
    );
    expect(result).toMatchObject({
      scenarioId: "account-loads",
      attemptNumber: 1,
      scriptVersion: 0,
      status: "passed",
    });
    await expect(
      readdir(join(runDirectory, "scenarios", "account-loads")),
    ).resolves.toEqual(["attempt-1"]);
    await expect(
      readFile(join(runDirectory, "report.md"), "utf8"),
    ).resolves.toContain(
      "Run Outcome: passed\n\n- account-loads: Attempt 1, Script Version 0, passed",
    );
    await expect(
      access(join(worktree, ".auto-qa", "registry.json")),
    ).rejects.toThrow();
    await expect(ownedBrowserProcesses()).resolves.toEqual([]);

    await expect(fetch(baseUrl).then((response) => response.text()))
      .resolves.toContain("<h1>Account</h1>");
  },
  30_000,
);
