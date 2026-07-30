import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";

const execFileAsync = promisify(execFile);

export type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export const runCliProcess = async ({
  cwd,
  args,
  env,
}: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> => {
  try {
    const result = await execFileAsync(
      process.execPath,
      [join(process.cwd(), "dist", "src", "cli.js"), ...args],
      { cwd, env },
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

export const parseOnlyJsonLine = <Envelope>(
  result: ProcessResult | undefined,
): Envelope => {
  const stdout = result?.stdout ?? "";
  expect(stdout.endsWith("\n")).toBe(true);
  const lines = stdout.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  return JSON.parse(lines[0] ?? "null") as Envelope;
};
