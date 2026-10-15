#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanup,
  kill,
  ownerAlive,
  ownerToken,
  runTmpDir,
} from "./processes.js";

const usage = `usage: auto-qa run [playwright test args...] --base-url <url> [--allow-remote]
       auto-qa cleanup`;

const run = async (args: string[]) => {
  let baseUrl: string | undefined;
  let allowRemote = false;
  const playwrightArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-remote") allowRemote = true;
    else if (args[i] === "--base-url") baseUrl = args[++i];
    else playwrightArgs.push(args[i]!);
  }
  if (playwrightArgs.includes("--")) throw new Error("`--` is not supported");
  if (baseUrl === undefined)
    throw new Error(`--base-url is required\n${usage}`);
  const local = ["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname);
  if (!local && !allowRemote) {
    throw new Error(
      `${baseUrl} is not local; pass --allow-remote to run only @readonly tests`
    );
  }

  const playwright = createRequire(resolve("package.json")).resolve(
    "@playwright/test/cli"
  );
  const runDir = resolve(
    ".auto-qa/runs",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
  );
  const token = ownerToken();
  mkdirSync(runTmpDir(token), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      playwright,
      "test",
      ...playwrightArgs,
      "--trace=on",
      `--output=${runDir}`,
      `--reporter=line,${fileURLToPath(new URL("reporter.js", import.meta.url))}`,
      ...(local ? [] : ["--grep=@readonly(?![\\w-])", "--no-deps"]),
    ],
    {
      detached: true,
      stdio: "inherit",
      env: {
        ...process.env,
        TMPDIR: runTmpDir(token),
        AUTO_QA_BASE_URL: baseUrl,
        AUTO_QA_RUN_DIR: runDir,
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
  try {
    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals,
    ];
    return code ?? 128 + constants.signals[signal];
  } finally {
    await cleanup((owner) => owner === token);
  }
};

const main = async ([command, ...args]: string[]) => {
  if (command === "run") return run(args);
  if (command !== "cleanup") throw new Error(usage);
  const swept = await cleanup((owner) => !ownerAlive(owner));
  console.log(
    `auto-qa: killed ${swept.processes} leftover processes, removed ${swept.dirs} temp dirs`
  );
  return 0;
};

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(
      `auto-qa: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  }
);
