#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { option, parse, usage } from "./args.js";
import { playwrightFor } from "./playwright.js";
import { guard, triage } from "./triage.js";
import { cleanup, kill, processId, runTmpDir } from "./processes.js";

const run = async (args: string[]) => {
  const { baseUrl, out, local, scratch, playwright } = await parse(args);

  const runDir = resolve(
    out || (scratch.length ? join(tmpdir(), "auto-qa-runs") : ".auto-qa/runs"),
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
  );
  const owner = processId(process.pid);
  mkdirSync(runTmpDir(owner), { recursive: true });
  try {
    const { cli, cwd } = playwrightFor(
      scratch,
      join(runTmpDir(owner), "scratch"),
      playwright.includes("--headed")
    );
    const child = spawn(
      process.execPath,
      [
        `--diagnostic-dir=${runTmpDir(owner)}`, // Marks the runner and workers.
        cli,
        "test",
        ...playwright,
        "--trace=on",
        `--output=${runDir}`,
        `--reporter=line,${fileURLToPath(new URL(`reporter${import.meta.url.slice(-3)}`, import.meta.url))}`,
        ...(local ? [] : ["--grep=@prod-safe(?![\\w-])", "--no-deps"]),
      ],
      {
        cwd,
        detached: true,
        stdio: "inherit",
        env: {
          ...process.env,
          TMPDIR: runTmpDir(owner),
          AUTO_QA_BASE_URL: baseUrl,
          AUTO_QA_PROD_SAFE_ONLY: local ? "" : "1",
          AUTO_QA_RUN_DIR: runDir,
          PLAYWRIGHT_TEST_BASE_URL: baseUrl,
        },
      }
    );

    // Ask Playwright to stop gracefully so it still writes the manifest, but
    // never wait on it for more than a few seconds.
    const interrupt = () => {
      kill(-child.pid!, "SIGINT");
      setTimeout(() => kill(-child.pid!, "SIGKILL"), 5000).unref();
    };
    process.on("SIGINT", interrupt).on("SIGTERM", interrupt);
    const [code, signal] = await once(child, "exit");
    return code ?? 128 + constants.signals[signal as NodeJS.Signals];
  } finally {
    await cleanup(owner);
  }
};

const main = async ([command, ...args]: string[]) => {
  if ([command, ...args].some((arg) => arg === "--help" || arg === "-h")) {
    console.log(usage);
    return 0;
  }
  if (command === "run") return run(args);
  if (command === "guard") return guard(option(args, "--base"), args);
  if (command === "triage") return triage(option(args, "--base"), args[0]!);
  if (command !== "cleanup") throw new Error(usage);
  const swept = await cleanup();
  console.log(
    `auto-qa: killed ${swept.processes} leftover processes, removed ${swept.dirs} temp dirs`
  );
  return 0;
};

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (error: Error) => {
    console.error(`auto-qa: ${error.message ?? error}`);
    process.exitCode = 2;
  }
);
