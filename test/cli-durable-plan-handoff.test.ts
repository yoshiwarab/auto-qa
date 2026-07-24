import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
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
    join(worktree, ".gitignore"),
    ".auto-qa/\n",
    "utf8",
  );
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
      { cwd: worktree },
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
});
