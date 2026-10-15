import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Effect, Exit, Scope } from "effect";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { makeQaLab, type QaLabProcess } from "../acceptance/qaLabHarness.js";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const cliPath = process.env["AUTO_QA_PACKED_CLI"];
if (cliPath === undefined) {
  throw new Error("AUTO_QA_PACKED_CLI must identify the packed CLI under test");
}
const temporaryDirectories: string[] = [];
let targetApplication: QaLabProcess | undefined;
let targetApplicationScope: Scope.CloseableScope | undefined;
let baseUrl: URL;

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = async (
  worktree: string,
  args: readonly string[],
  secretCanary: string
): Promise<ProcessResult> => {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: worktree,
      env: {
        ...process.env,
        AUTO_QA_SECRET_CANARY: secretCanary,
        PLAYWRIGHT_BROWSERS_PATH: join(
          projectRoot,
          "tmp",
          "playwright-browsers"
        ),
      },
    });
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
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
  const browserRoot = join(projectRoot, "tmp", "playwright-browsers");
  return stdout
    .split("\n")
    .filter(
      (line) =>
        line.includes(browserRoot) ||
        line.includes(join(dirname(cliPath), "nodeBrowserLauncher.js"))
    );
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
    { cwd: worktree }
  );
  await execFileAsync("git", ["config", "user.name", "Auto QA Harness"], {
    cwd: worktree,
  });
  await writeFile(
    join(worktree, "account.tsx"),
    "export const heading = 'Baseline';\n"
  );
  await execFileAsync("git", ["add", "."], { cwd: worktree });
  await execFileAsync("git", ["commit", "-m", "Committed baseline"], {
    cwd: worktree,
  });
  await writeFile(
    join(worktree, "account.tsx"),
    "export const heading = 'Account';\n"
  );
  return worktree;
};

beforeAll(async () => {
  targetApplicationScope = Effect.runSync(Scope.make());
  targetApplication = await Effect.runPromise(
    makeQaLab(projectRoot).pipe(
      Effect.provideService(Scope.Scope, targetApplicationScope)
    )
  );
  baseUrl = targetApplication.baseUrl;
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true }))
  );
});

afterAll(async () => {
  if (targetApplicationScope !== undefined) {
    await Effect.runPromise(Scope.close(targetApplicationScope, Exit.void));
  }
});

test("one passing Scenario completes the Run with durable evidence", async () => {
  const worktree = await makeChangedWorktree();
  const secretCanary = `auto-qa-secret-canary-${randomUUID()}`;
  const processOutput: string[] = [];
  const start = await runCli(
    worktree,
    ["start", "--base-url", baseUrl.href],
    secretCanary
  );
  processOutput.push(start.stdout, start.stderr);
  const started = parseEnvelope(start);
  expect(start).toMatchObject({ exitCode: 0 });
  const job = started.result.job;
  expect(job).not.toBeNull();
  expect(job).toBeDefined();

  const submissionPath = join(
    projectRoot,
    "tmp",
    `passing-plan-${started.result.runId}.json`
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
    })
  );
  temporaryDirectories.push(submissionPath);

  const submit = await runCli(
    worktree,
    [
      "submit",
      started.result.runId,
      "--job-id",
      job?.id ?? "",
      "--file",
      submissionPath,
    ],
    secretCanary
  );
  processOutput.push(submit.stdout, submit.stderr);
  const reviewed = parseEnvelope(submit);
  expect(submit, submit.stdout).toMatchObject({ exitCode: 0 });
  expect(reviewed.result).toMatchObject({
    phase: "awaitingAgent",
    pendingJob: { type: "classify-findings" },
  });
  const reviewPath = join(worktree, "review.json");
  await writeFile(
    reviewPath,
    JSON.stringify({
      schemaVersion: 1,
      resolution: "report-only",
      classifications: [
        {
          findingId: `${started.result.runId}:account-loads:1`,
          classification: "verified-success",
          reasoning:
            "Synthetic reviewer fixture: Account heading and layout verified.",
          reviewedEvidence: ["final.png", "final.aria.yaml"],
          coverageComplete: true,
        },
      ],
    })
  );
  const reviewResult = await runCli(
    worktree,
    [
      "submit",
      started.result.runId,
      "--job-id",
      `${started.result.runId}:classify-findings:1`,
      "--file",
      reviewPath,
    ],
    secretCanary
  );
  expect(reviewResult.exitCode, reviewResult.stdout).toBe(0);
  const submitted = parseEnvelope(reviewResult);
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
    secretCanary
  );
  processOutput.push(jobStatus.stdout, jobStatus.stderr);
  const observedJob = parseEnvelope(jobStatus);
  const runStatus = await runCli(
    worktree,
    ["status", started.result.runId],
    secretCanary
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

  const runDirectory = join(worktree, ".auto-qa", "runs", started.result.runId);
  const attemptDirectory = join(
    runDirectory,
    "scenarios",
    "account-loads",
    "attempt-1"
  );
  const manifestText = await readFile(
    join(attemptDirectory, "manifest.json"),
    "utf8"
  );
  const manifest = JSON.parse(manifestText);
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    files: ["result.json", "final.png", "final.aria.yaml"],
  });
  const resultText = await readFile(
    join(attemptDirectory, "result.json"),
    "utf8"
  );
  const result = JSON.parse(resultText);
  expect(result).toMatchObject({
    scenarioId: "account-loads",
    attemptNumber: 1,
    scriptVersion: 0,
    status: "passed",
  });
  await expect(
    readdir(join(runDirectory, "scenarios", "account-loads"))
  ).resolves.toEqual(["attempt-1"]);
  const reportText = await readFile(join(runDirectory, "report.md"), "utf8");
  expect(reportText).toContain("Run Outcome: passed");
  const persistedState = await readFile(join(worktree, ".auto-qa", "state.db"));
  expect(
    [
      ...processOutput,
      manifestText,
      resultText,
      reportText,
      persistedState.toString("utf8"),
    ].join("\n")
  ).not.toContain(secretCanary);
  await expect(
    access(join(worktree, ".auto-qa", "registry.json"))
  ).rejects.toThrow();
  await expect(ownedBrowserProcesses()).resolves.toEqual([]);
  expect(await readdir(join(worktree, ".auto-qa", "runtime"))).toEqual([]);
  expect(
    (await readdir(join(worktree, ".auto-qa"))).filter((name) =>
      name.startsWith(".browser-launch-")
    )
  ).toEqual([]);

  const cleaned = await runCli(worktree, ["cleanup"], secretCanary);
  expect(cleaned.exitCode, cleaned.stdout).toBe(0);
  expect(JSON.parse(cleaned.stdout)).toMatchObject({
    result: { status: "clean" },
  });
  const afterCleanup = await runCli(
    worktree,
    ["status", started.result.runId],
    secretCanary
  );
  expect(parseEnvelope(afterCleanup).result).toEqual(observedStatus.result);
  expect(await readFile(join(runDirectory, "report.md"), "utf8")).toBe(
    reportText
  );
  expect(await readFile(join(attemptDirectory, "result.json"), "utf8")).toBe(
    resultText
  );

  expect(targetApplication?.isRunning()).toBe(true);
  await expect(
    fetch(baseUrl).then((response) => response.text())
  ).resolves.toContain("Account");
}, 30_000);

const killBrowserGroup = (groupId: number): void => {
  try {
    process.kill(-groupId, "SIGKILL");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
      throw cause;
  }
};

test.each([
  "direct",
  "standalone-cleanup",
  "retry-cleanup",
  "workspace-symlink",
  "workspace-replaced",
  "wrong-token",
  "reused-pid",
  "leader-gone",
  "intent-only",
  "launch-crash",
  "launch-supervisor-gone",
  "launch-both-gone",
  "launch-wrong-token",
])(
  "recovery removes a stopped browser tree after SIGKILL without replaying the Scenario: %s",
  async (mode) => {
    const crashDuringLaunch = mode.startsWith("launch-");
    const worktree = await makeChangedWorktree();
    const started = parseEnvelope(
      await runCli(
        worktree,
        ["start", "--base-url", baseUrl.href],
        "crash-canary"
      )
    );
    const submissionPath = join(
      projectRoot,
      "tmp",
      `crash-plan-${randomUUID()}.json`
    );
    temporaryDirectories.push(submissionPath);
    await writeFile(
      submissionPath,
      JSON.stringify({
        schemaVersion: 1,
        scenarios: [
          ...(mode === "standalone-cleanup"
            ? [
                {
                  id: "finished-account",
                  goal: "Publish evidence before the next Scenario is interrupted",
                  preconditions: [],
                  mutates: false,
                  script:
                    "async ({ page, baseUrl }) => { await page.goto(baseUrl.href); }",
                },
              ]
            : []),
          {
            id: "held-account",
            goal: "The account page loads before interruption",
            preconditions: [],
            mutates: false,
            script:
              "async ({ page, baseUrl }) => { await page.goto(baseUrl.href); process.send('scenario-ready'); await new Promise(() => {}); }",
          },
        ],
      })
    );
    const args = [
      "submit",
      started.result.runId,
      "--job-id",
      started.result.job?.id ?? "",
      "--file",
      submissionPath,
    ];
    const unrelatedBrowser = await chromium.launch({
      executablePath: chromium.executablePath(),
      args: [`--auto-qa-launch-token=${randomUUID()}`],
    });
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: worktree,
      env: { ...process.env, AUTO_QA_SECRET_CANARY: "crash-canary" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    const exited = once(child, "exit");
    let browserGroup: number | undefined;
    let profileDirectory: string | undefined;
    let stagingDirectory: string | undefined;
    let publishedEvidence: string | undefined;
    let unrelatedDirectory: string | undefined;
    const publishedDirectory = join(
      worktree,
      ".auto-qa",
      "runs",
      started.result.runId,
      "scenarios",
      "finished-account",
      "attempt-1"
    );
    try {
      if (crashDuringLaunch) {
        // Stop the actual CLI as soon as it spawns the launcher, before launch
        // resolves. No production crash hook or rewritten registry is needed.
        await expect
          .poll(
            async () => {
              const children = await readFile(
                `/proc/${child.pid}/task/${child.pid}/children`,
                "utf8"
              );
              if (children.trim() === "") return false;
              const commands = await Promise.all(
                children
                  .trim()
                  .split(/\s+/)
                  .map((pid) =>
                    readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")
                  )
              );
              if (
                !commands.some((command) =>
                  command.includes("--auto-qa-launch-token=")
                )
              )
                return false;
              child.kill("SIGSTOP");
              return true;
            },
            { timeout: 10_000, interval: 5 }
          )
          .toBe(true);
        const registry = JSON.parse(
          await readFile(join(worktree, ".auto-qa", "registry.json"), "utf8")
        );
        expect(
          registry.processes.filter(
            (entry: { executablePath: string }) =>
              entry.executablePath === chromium.executablePath()
          )
        ).toEqual([]);
      } else
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Scenario did not reach its checkpoint")),
            10_000
          );
          child.once("message", (message) => {
            clearTimeout(timeout);
            if (message === "scenario-ready") resolve();
            else reject(new Error("Unexpected Scenario checkpoint"));
          });
          child.once("exit", () => {
            clearTimeout(timeout);
            reject(new Error("CLI exited before its Scenario checkpoint"));
          });
        });
      const roots = await execFileAsync("ps", [
        "--ppid",
        String(child.pid),
        "-o",
        "pid=",
      ]);
      const rootIds = roots.stdout.trim().split(/\s+/).map(Number);
      expect(rootIds).toHaveLength(1);
      const root = rootIds[0];
      if (root === undefined || !Number.isSafeInteger(root) || root <= 1)
        throw new Error("Missing browser PID");
      const group = await execFileAsync("ps", [
        "-p",
        String(root),
        "-o",
        "pgid=",
      ]);
      expect(Number(group.stdout.trim())).toBe(root);
      browserGroup = root;
      const launchArguments = (
        await readFile(`/proc/${root}/cmdline`, "utf8")
      ).split("\0");
      const profileArgument = launchArguments.find((argument) =>
        argument.startsWith("--user-data-dir=")
      );
      if (profileArgument === undefined)
        throw new Error("Missing browser profile directory");
      profileDirectory = profileArgument.slice("--user-data-dir=".length);
      await access(profileDirectory);

      if (crashDuringLaunch) {
        // The launcher journals itself and starts Chromium while the CLI is
        // stopped in launch. Wait for browser descendants, not just the shim.
        await expect
          .poll(
            async () => {
              const processes = await execFileAsync("ps", [
                "-eo",
                "pid=,pgid=,stat=,args=",
              ]);
              return processes.stdout.split("\n").filter((line) => {
                const [pid, pgid, state] = line.trim().split(/\s+/);
                return (
                  Number(pgid) === root &&
                  Number(pid) !== root &&
                  !state?.startsWith("Z") &&
                  line.includes("--type=zygote")
                );
              }).length;
            },
            { timeout: 5_000 }
          )
          .toBeGreaterThan(0);
      }

      if (mode === "direct" || mode === "standalone-cleanup") {
        const registryPath = join(worktree, ".auto-qa", "registry.json");
        const before = await readFile(registryPath, "utf8");
        const competing = await runCli(
          worktree,
          mode === "standalone-cleanup" ? ["cleanup"] : args,
          "crash-canary"
        );
        expect(competing.exitCode).not.toBe(0);
        expect(JSON.parse(competing.stdout)).toMatchObject({
          error: { code: "RunBusyError" },
        });
        expect(await readFile(registryPath, "utf8")).toBe(before);
      }

      // Hold the entire owned tree so pipe closure cannot mask missing recovery.
      process.kill(-browserGroup, "SIGSTOP");
      if (mode === "standalone-cleanup") {
        publishedEvidence = await readFile(
          join(publishedDirectory, "result.json"),
          "utf8"
        );
        const entries = await readdir(join(worktree, ".auto-qa"), {
          recursive: true,
          withFileTypes: true,
        });
        const staging = entries.filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.startsWith(".attempt-") &&
            entry.name.endsWith(".tmp")
        );
        expect(staging).toHaveLength(1);
        const entry = staging[0];
        if (entry === undefined)
          throw new Error("Missing staged Evidence Bundle");
        stagingDirectory = join(entry.parentPath, entry.name);
        await writeFile(
          join(stagingDirectory, "partial.json"),
          "unpublished evidence"
        );
        unrelatedDirectory = await mkdtemp(
          join(projectRoot, "tmp", "unrelated-evidence-")
        );
        temporaryDirectories.push(unrelatedDirectory);
        await writeFile(join(unrelatedDirectory, "sentinel"), "keep me");
        await symlink(unrelatedDirectory, join(stagingDirectory, "external"));
      }
      child.kill("SIGKILL");
      await exited;
      const status = await runCli(
        worktree,
        ["status", started.result.runId],
        "crash-canary"
      );
      expect(parseEnvelope(status).result.phase).toBe("executingScenarios");
      process.kill(browserGroup, 0);
      expect(
        await readFile(join(worktree, ".auto-qa", "registry.json"), "utf8")
      ).not.toContain("crash-canary");

      if (mode === "leader-gone" || mode === "launch-supervisor-gone")
        process.kill(browserGroup, "SIGKILL");
      else if (crashDuringLaunch) {
        const children = await readFile(
          `/proc/${browserGroup}/task/${browserGroup}/children`,
          "utf8"
        );
        const browser = Number(children.trim());
        expect(Number.isSafeInteger(browser) && browser > 1).toBe(true);
        process.kill(browser, "SIGKILL");
        if (mode === "launch-both-gone") {
          process.kill(browserGroup, "SIGKILL");
          // Signal delivery is asynchronous. Do not start reconciliation while
          // either killed leader can still serve as a live ownership witness.
          await expect
            .poll(
              async () => {
                const states = await Promise.all(
                  [browser, browserGroup].map(async (pid) => {
                    const stat = await readFile(
                      `/proc/${pid}/stat`,
                      "utf8"
                    ).catch((error: unknown) => {
                      if (
                        typeof error === "object" &&
                        error !== null &&
                        "code" in error &&
                        error.code === "ENOENT"
                      )
                        return "";
                      throw error;
                    });
                    return (
                      stat === "" ||
                      stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")
                    );
                  })
                );
                return states.every(Boolean);
              },
              { timeout: 5000 }
            )
            .toBe(true);
        }
      }
      if (mode === "launch-both-gone") {
        const registryPath = join(worktree, ".auto-qa", "registry.json");
        const before = await readFile(registryPath, "utf8");
        const ambiguous = await runCli(worktree, ["cleanup"], "crash-canary");
        expect(ambiguous.exitCode).not.toBe(0);
        expect(await readFile(registryPath, "utf8")).toBe(before);
        process.kill(-browserGroup, 0);
        // Only the harness has independent ownership proof of this fixture.
        killBrowserGroup(browserGroup);
      }
      if (mode === "intent-only") {
        const registryPath = join(worktree, ".auto-qa", "registry.json");
        const parsed: unknown = JSON.parse(
          await readFile(registryPath, "utf8")
        );
        if (typeof parsed !== "object" || parsed === null)
          throw new Error("Missing registry");
        await writeFile(
          registryPath,
          JSON.stringify({ ...parsed, processes: [] })
        );
      }

      if (
        mode === "retry-cleanup" ||
        mode === "wrong-token" ||
        mode === "launch-wrong-token" ||
        mode === "reused-pid"
      ) {
        const registryPath = join(worktree, ".auto-qa", "registry.json");
        const registry = await readFile(registryPath, "utf8");
        const parsed: unknown = JSON.parse(registry);
        if (typeof parsed !== "object" || parsed === null)
          throw new Error("Missing registry");
        if (!("processes" in parsed) || !Array.isArray(parsed.processes))
          throw new Error("Missing recorded processes");
        const reused = parsed.processes.map((entry: unknown) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            !("processId" in entry)
          )
            throw new Error("Missing process identity");
          return entry.processId === browserGroup
            ? { ...entry, startTicks: "0" }
            : entry;
        });
        const corrupt =
          mode === "retry-cleanup"
            ? "{"
            : JSON.stringify(
                mode === "wrong-token" || mode === "launch-wrong-token"
                  ? { ...parsed, launchToken: randomUUID() }
                  : { ...parsed, processes: reused }
              );
        await writeFile(registryPath, corrupt);
        const failed = await runCli(
          worktree,
          mode === "retry-cleanup" || crashDuringLaunch ? ["cleanup"] : args,
          "crash-canary"
        );
        expect(failed.exitCode).not.toBe(0);
        expect(await readFile(registryPath, "utf8")).toBe(corrupt);
        process.kill(-browserGroup, 0);
        await writeFile(registryPath, registry);
      }

      if (mode === "workspace-symlink" || mode === "workspace-replaced") {
        const workspaceDirectory = dirname(profileDirectory);
        const savedDirectory = `${workspaceDirectory}.saved`;
        unrelatedDirectory = await mkdtemp(
          join(projectRoot, "tmp", "unrelated-workspace-")
        );
        temporaryDirectories.push(unrelatedDirectory);
        await writeFile(join(unrelatedDirectory, "sentinel"), "keep me");
        await rename(workspaceDirectory, savedDirectory);
        try {
          if (mode === "workspace-symlink")
            await symlink(unrelatedDirectory, workspaceDirectory);
          else {
            await mkdir(workspaceDirectory);
            await writeFile(join(workspaceDirectory, "sentinel"), "keep me");
          }
          const failed = await runCli(worktree, ["cleanup"], "crash-canary");
          expect(failed.exitCode).not.toBe(0);
          await access(join(worktree, ".auto-qa", "registry.json"));
          expect(
            await readFile(join(workspaceDirectory, "sentinel"), "utf8")
          ).toBe("keep me");
          expect(
            await readFile(join(unrelatedDirectory, "sentinel"), "utf8")
          ).toBe("keep me");
        } finally {
          // Only these test-created replacement paths are removed; restore the
          // original inode so the CLI can safely retry its registered cleanup.
          await rm(workspaceDirectory, { recursive: true, force: true });
          await rename(savedDirectory, workspaceDirectory);
        }
      }

      if (
        mode === "standalone-cleanup" ||
        mode === "retry-cleanup" ||
        mode.startsWith("workspace-") ||
        crashDuringLaunch
      ) {
        for (let invocation = 0; invocation < 2; invocation += 1) {
          const cleaned = await runCli(worktree, ["cleanup"], "crash-canary");
          expect(cleaned.exitCode, cleaned.stdout + cleaned.stderr).toBe(0);
          expect(JSON.parse(cleaned.stdout)).toMatchObject({
            result: { status: "clean" },
          });
          if (mode === "standalone-cleanup")
            await expect(access(profileDirectory)).rejects.toThrow();
          if (stagingDirectory !== undefined)
            await expect(access(stagingDirectory)).rejects.toThrow();
        }
        const afterCleanup = await runCli(
          worktree,
          ["status", started.result.runId],
          "crash-canary"
        );
        expect(parseEnvelope(afterCleanup).result).toEqual(
          parseEnvelope(status).result
        );
        await expect(
          access(join(worktree, ".auto-qa", "registry.json"))
        ).rejects.toThrow();
        const processes = await execFileAsync("ps", ["-eo", "pgid=,stat="]);
        expect(
          processes.stdout.split("\n").filter((line) => {
            const [pgid, state] = line.trim().split(/\s+/);
            return Number(pgid) === browserGroup && !state?.startsWith("Z");
          })
        ).toEqual([]);
      }

      const recovered = await runCli(worktree, args, "crash-canary");
      expect(recovered.exitCode, recovered.stdout).toBe(0);
      expect(parseEnvelope(recovered).result).toMatchObject({
        phase: "awaitingAgent",
        pendingJob: {
          type: "classify-findings",
          payload: {
            findings:
              mode === "standalone-cleanup"
                ? [
                    { mechanicalStatus: "passed" },
                    { mechanicalStatus: "interrupted" },
                  ]
                : [{ mechanicalStatus: "interrupted" }],
          },
        },
      });
      const processes = await execFileAsync("ps", ["-eo", "pgid=,stat="]);
      const liveOwned = processes.stdout.split("\n").filter((line) => {
        const [pgid, state] = line.trim().split(/\s+/);
        return Number(pgid) === browserGroup && !state?.startsWith("Z");
      });
      expect(liveOwned).toEqual([]);
      await expect(access(profileDirectory)).rejects.toThrow();
      expect(await readdir(join(worktree, ".auto-qa", "runtime"))).toEqual([]);
      if (publishedEvidence !== undefined) {
        expect(
          await readFile(join(publishedDirectory, "result.json"), "utf8")
        ).toBe(publishedEvidence);
        expect(
          JSON.parse(
            await readFile(join(publishedDirectory, "manifest.json"), "utf8")
          )
        ).toMatchObject({
          files: ["result.json", "final.png", "final.aria.yaml"],
        });
      }
      if (unrelatedDirectory !== undefined)
        expect(
          await readFile(join(unrelatedDirectory, "sentinel"), "utf8")
        ).toBe("keep me");
      await expect(
        access(join(worktree, ".auto-qa", "registry.json"))
      ).rejects.toThrow();
      expect(
        (await readdir(join(worktree, ".auto-qa"))).filter((name) =>
          name.startsWith(".browser-launch-")
        )
      ).toEqual([]);
      const repeated = await runCli(worktree, args, "crash-canary");
      expect(parseEnvelope(repeated).result).toEqual(
        parseEnvelope(recovered).result
      );
      expect(targetApplication?.isRunning()).toBe(true);
      expect((await fetch(baseUrl)).ok).toBe(true);
      const unrelatedPage = await unrelatedBrowser.newPage();
      await unrelatedPage.goto(baseUrl.href);
      expect(
        await unrelatedPage.getByRole("heading", { name: "Account" }).count()
      ).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      if (browserGroup !== undefined) {
        killBrowserGroup(browserGroup);
      }
      await unrelatedBrowser.close();
      await expect.poll(ownedBrowserProcesses, { timeout: 5_000 }).toEqual([]);
      if (profileDirectory !== undefined)
        await rm(profileDirectory, { recursive: true, force: true });
    }
  },
  30_000
);
