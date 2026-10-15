#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { playwrightFor } from "./playwright.js";
import { guard, triage } from "./triage.js";
import { cleanup, kill, processId, runTmpDir } from "./processes.js";

const usage = `usage: auto-qa run [playwright test args...] --base-url <url>
         [--scratch <spec file>]... [--out <dir>] [--allow-remote]
       auto-qa triage <manifest.json> [--base <git ref>]
       auto-qa guard [--base <git ref>] [paths...]
       auto-qa cleanup`;

// Removes `--name <value>` from args and returns the value.
const option = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};

const parse = (args: string[]) => {
  const baseUrl = option(args, "--base-url");
  const out = option(args, "--out");
  const scratch: string[] = [];
  for (let spec; (spec = option(args, "--scratch"));)
    scratch.push(resolve(spec));
  const playwright = args.filter((arg) => arg !== "--allow-remote");
  if (playwright.includes("--")) throw new Error("`--` is not supported");
  if (!baseUrl) throw new Error(`--base-url is required\n${usage}`);
  const allowRemote = args.includes("--allow-remote");
  return { baseUrl, out, allowRemote, scratch, playwright };
};

const run = async (args: string[]) => {
  const { baseUrl, out, allowRemote, scratch, playwright } = parse(args);
  const local = /(^|\.)localhost$|^127\.0\.0\.1$|^\[::1\]$/.test(
    new URL(baseUrl).hostname
  );
  if (!local && !allowRemote) {
    throw new Error(
      `${baseUrl} is not local; pass --allow-remote to run only @prod-safe tests`
    );
  }

  const runDir = resolve(
    out || (scratch.length ? join(tmpdir(), "auto-qa-runs") : ".auto-qa/runs"),
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
  );
  const owner = processId(process.pid);
  mkdirSync(runTmpDir(owner), { recursive: true });
  try {
    const { cli, cwd } = playwrightFor(
      scratch,
      join(runTmpDir(owner), "scratch")
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
        `--reporter=line,${fileURLToPath(new URL("reporter.js", import.meta.url))}`,
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
