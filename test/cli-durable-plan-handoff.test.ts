import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "src", "cli.js");
let targetApplication: Server;
let baseUrl: URL;
let targetApplicationRequestCount = 0;

const makeTemporaryGitWorktree = async (): Promise<string> => {
  const parent = join(projectRoot, "tmp");
  await mkdir(parent, { recursive: true });
  const worktree = await mkdtemp(join(parent, "cli-worktree-"));
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
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(
    join(worktree, "src", "dashboard.tsx"),
    "export const dashboard = 'baseline';\n",
    "utf8",
  );
  await execFileAsync("git", ["add", "."], { cwd: worktree });
  await execFileAsync(
    "git",
    ["commit", "-m", "Committed baseline"],
    { cwd: worktree },
  );

  return worktree;
};

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
      { cwd: join(worktree, "src") },
    );
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
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

const parseOnlyJsonLine = (stdout: string): unknown => {
  expect(stdout.endsWith("\n")).toBe(true);
  const lines = stdout.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  return JSON.parse(lines[0] ?? "null") as unknown;
};

const pathExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  await execFileAsync(
    process.execPath,
    [
      join(projectRoot, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      join(projectRoot, "tsconfig.build.json"),
    ],
    { cwd: projectRoot },
  );

  targetApplication = createServer((_request, response) => {
    targetApplicationRequestCount += 1;
    response.end("ok");
  });
  await new Promise<void>((resolve) => {
    targetApplication.listen(0, "127.0.0.1", resolve);
  });
  const address = targetApplication.address() as AddressInfo;
  baseUrl = new URL(`http://127.0.0.1:${address.port}`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    targetApplication.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true }),
    ),
  );
});

describe("CLI durable generate-plan handoff", () => {
  test("start, job, and status share durable versioned state", async () => {
    const worktree = await makeTemporaryGitWorktree();
    await writeFile(
      join(worktree, "src", "dashboard.tsx"),
      "export const dashboard = 'modified';\n",
      "utf8",
    );

    const start = await runCli(worktree, [
      "start",
      "--base-url",
      baseUrl.href,
    ]);
    const startEnvelope = parseOnlyJsonLine(start.stdout) as {
      readonly schemaVersion: number;
      readonly correlationId: string;
      readonly ok: boolean;
      readonly result: {
        readonly runId: string;
        readonly phase: string;
        readonly job: unknown;
      };
    };
    const job = await runCli(worktree, [
      "job",
      startEnvelope.result.runId,
    ]);
    const status = await runCli(worktree, [
      "status",
      startEnvelope.result.runId,
    ]);
    const jobEnvelope = parseOnlyJsonLine(job.stdout) as {
      readonly schemaVersion: number;
      readonly correlationId: string;
      readonly ok: boolean;
      readonly result: {
        readonly phase: string;
        readonly job: unknown;
      };
    };
    const statusEnvelope = parseOnlyJsonLine(status.stdout) as {
      readonly schemaVersion: number;
      readonly correlationId: string;
      readonly ok: boolean;
      readonly result: {
        readonly phase: string;
      };
    };

    expect([start, job, status]).toEqual([
      expect.objectContaining({ exitCode: 0, stderr: "" }),
      expect.objectContaining({ exitCode: 0, stderr: "" }),
      expect.objectContaining({ exitCode: 0, stderr: "" }),
    ]);
    for (const envelope of [
      startEnvelope,
      jobEnvelope,
      statusEnvelope,
    ]) {
      expect(envelope).toMatchObject({
        schemaVersion: 1,
        ok: true,
        correlationId: expect.any(String),
      });
      expect(envelope.correlationId.length).toBeGreaterThan(0);
    }
    expect(jobEnvelope.result.job).toEqual(
      startEnvelope.result.job,
    );
    expect(startEnvelope.result.job).toMatchObject({
      schemaVersion: 1,
      type: "generate-plan",
      payload: {
        baseUrl: baseUrl.href,
        changes: [
          {
            kind: "modified",
            path: "src/dashboard.tsx",
          },
        ],
      },
    });
    expect(startEnvelope.result.phase).toBe("awaitingAgent");
    expect(jobEnvelope.result.phase).toBe("awaitingAgent");
    expect(statusEnvelope.result.phase).toBe("awaitingAgent");
  });

  test("usage failures preserve Commander error codes", async () => {
    const worktree = await makeTemporaryGitWorktree();
    const result = await runCli(worktree, ["start"]);
    const envelope = parseOnlyJsonLine(result.stdout);

    expect(result).toMatchObject({
      exitCode: 2,
      stderr: "",
    });
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      ok: false,
      correlationId: expect.any(String),
      error: {
        code: "commander.missingMandatoryOptionValue",
      },
    });
  });

  test("read-only failures preserve domain codes without creating state", async () => {
    const worktree = await makeTemporaryGitWorktree();
    const result = await runCli(worktree, [
      "status",
      "missing-run",
    ]);
    const envelope = parseOnlyJsonLine(result.stdout);

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: "",
    });
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      ok: false,
      correlationId: expect.any(String),
      error: {
        code: "WorkflowStoreError",
        message: "Auto-QA failed during open Run Store",
      },
    });
    await expect(
      pathExists(join(worktree, ".auto-qa")),
    ).resolves.toBe(false);
  });

  test("start outside Git fails before creating durable state", async () => {
    const directory = await mkdtemp(
      join(projectRoot, "tmp", "non-git-directory-"),
    );
    temporaryDirectories.push(directory);
    targetApplicationRequestCount = 0;
    let result: ProcessResult;
    try {
      const processResult = await execFileAsync(
        process.execPath,
        [cliPath, "start", "--base-url", baseUrl.href],
        {
          cwd: directory,
          env: {
            ...process.env,
            GIT_CEILING_DIRECTORIES: projectRoot,
          },
        },
      );
      result = { exitCode: 0, ...processResult };
    } catch (cause) {
      const failure = cause as {
        readonly code?: number;
        readonly stdout?: string;
        readonly stderr?: string;
      };
      result = {
        exitCode: failure.code ?? 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }

    expect(result).toMatchObject({ exitCode: 1, stderr: "" });
    expect(parseOnlyJsonLine(result.stdout)).toMatchObject({
      schemaVersion: 1,
      correlationId: expect.any(String),
      ok: false,
      error: {
        code: "GitWorktreeRequiredError",
        message: "Auto-QA must run inside a Git worktree",
      },
    });
    await expect(
      pathExists(join(directory, ".auto-qa")),
    ).resolves.toBe(false);
    expect(targetApplicationRequestCount).toBe(0);
  });

  test("a second start identifies the active Run without replacing it", async () => {
    const worktree = await makeTemporaryGitWorktree();
    const first = await runCli(worktree, [
      "start",
      "--base-url",
      baseUrl.href,
    ]);
    const firstEnvelope = parseOnlyJsonLine(first.stdout) as {
      readonly result: { readonly runId: string };
    };

    const second = await runCli(worktree, [
      "start",
      "--base-url",
      baseUrl.href,
    ]);
    const secondEnvelope = parseOnlyJsonLine(second.stdout);
    const status = await runCli(worktree, [
      "status",
      firstEnvelope.result.runId,
    ]);
    const statusEnvelope = parseOnlyJsonLine(status.stdout);
    expect(first).toMatchObject({ exitCode: 0, stderr: "" });
    expect(second).toMatchObject({ exitCode: 1, stderr: "" });
    expect(secondEnvelope).toMatchObject({
      schemaVersion: 1,
      correlationId: expect.any(String),
      ok: false,
      error: {
        code: "ActiveRunExistsError",
        message: `Run ${firstEnvelope.result.runId} is already active in this worktree`,
        details: {
          activeRunId: firstEnvelope.result.runId,
        },
      },
    });
    expect(status).toMatchObject({ exitCode: 0, stderr: "" });
    expect(statusEnvelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: {
        phase: "awaitingAgent",
      },
    });
  });

  test("abandon releases the worktree for a new Run", async () => {
    const worktree = await makeTemporaryGitWorktree();
    const first = await runCli(worktree, [
      "start",
      "--base-url",
      baseUrl.href,
    ]);
    const firstEnvelope = parseOnlyJsonLine(first.stdout) as {
      readonly result: { readonly runId: string };
    };
    const reason = "superseded by updated changes";

    const abandon = await runCli(worktree, [
      "runs",
      "abandon",
      firstEnvelope.result.runId,
      "--reason",
      reason,
    ]);
    const abandonEnvelope = parseOnlyJsonLine(abandon.stdout);
    const status = await runCli(worktree, [
      "status",
      firstEnvelope.result.runId,
    ]);
    const statusEnvelope = parseOnlyJsonLine(status.stdout);
    const job = await runCli(worktree, [
      "job",
      firstEnvelope.result.runId,
    ]);
    const jobEnvelope = parseOnlyJsonLine(job.stdout);
    const next = await runCli(worktree, [
      "start",
      "--base-url",
      baseUrl.href,
    ]);
    const nextEnvelope = parseOnlyJsonLine(next.stdout) as {
      readonly result: {
        readonly runId: string;
        readonly phase: string;
      };
    };

    for (const result of [abandon, status, job, next]) {
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    }
    for (const envelope of [
      abandonEnvelope,
      statusEnvelope,
      nextEnvelope,
    ]) {
      expect(envelope).toMatchObject({
        schemaVersion: 1,
        correlationId: expect.any(String),
        ok: true,
      });
    }
    expect(abandonEnvelope).toMatchObject({
      result: { phase: "abandoned", reason },
    });
    expect(statusEnvelope).toMatchObject({
      result: { phase: "abandoned", reason },
    });
    expect(jobEnvelope).toMatchObject({
      result: { phase: "abandoned", job: null },
    });
    expect(nextEnvelope.result).toMatchObject({
      phase: "awaitingAgent",
    });
    expect(nextEnvelope.result.runId).not.toBe(
      firstEnvelope.result.runId,
    );
  });

  test("abandon migrates durable state and keeps terminal history immutable", async () => {
    const worktree = await makeTemporaryGitWorktree();
    const stateDirectory = join(worktree, ".auto-qa");
    await mkdir(stateDirectory, { recursive: true });
    const database = new DatabaseSync(
      join(stateDirectory, "state.db"),
    );
    database.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        base_url TEXT NOT NULL
      ) STRICT;
      CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        recovery_policy TEXT NOT NULL
      ) STRICT;
      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
        job_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE turn_lock (
        lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1),
        run_id TEXT NOT NULL,
        process_id INTEGER NOT NULL,
        process_started_at TEXT NOT NULL,
        ownership_token TEXT NOT NULL UNIQUE
      ) STRICT;
    `);
    database
      .prepare(
        "INSERT INTO runs (run_id, phase, base_url) VALUES ('legacy-run', 'awaitingAgent', ?)",
      )
      .run(baseUrl.href);
    database.close();

    const legacyStatus = await runCli(worktree, [
      "status",
      "legacy-run",
    ]);
    const abandoned = await runCli(worktree, [
      "runs",
      "abandon",
      "legacy-run",
      "--reason",
      "superseded",
    ]);
    const repeated = await runCli(worktree, [
      "runs",
      "abandon",
      "legacy-run",
      "--reason",
      "overwritten",
    ]);
    const status = await runCli(worktree, [
      "status",
      "legacy-run",
    ]);

    expect(legacyStatus).toMatchObject({ exitCode: 0, stderr: "" });
    expect(parseOnlyJsonLine(legacyStatus.stdout)).toMatchObject({
      ok: true,
      result: { phase: "awaitingAgent" },
    });
    expect(abandoned).toMatchObject({ exitCode: 0, stderr: "" });
    expect(repeated).toMatchObject({ exitCode: 1, stderr: "" });
    expect(parseOnlyJsonLine(repeated.stdout)).toMatchObject({
      ok: false,
      error: { code: "InvalidTransitionError" },
    });
    expect(parseOnlyJsonLine(status.stdout)).toMatchObject({
      ok: true,
      result: {
        phase: "abandoned",
        reason: "superseded",
      },
    });
  });
});
