import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vitest";

const app = fileURLToPath(new URL("app/", import.meta.url));
const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const server = createServer((_, response) =>
  response.end(readFileSync(join(app, "index.html")))
);
let baseUrl = "";

beforeAll(async () => {
  await once(server.listen(0, "127.0.0.1"), "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const read = (path: string) => {
  try {
    return readFileSync(path, "latin1");
  } catch {
    return "";
  }
};

const processes = () =>
  readdirSync("/proc")
    .filter((pid) => /^\d+$/.test(pid))
    .map((pid) => {
      const stat = read(`/proc/${pid}/stat`);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return {
        pid: Number(pid),
        state: fields[0],
        pgid: Number(fields[2]),
        cmdline: read(`/proc/${pid}/cmdline`),
      };
    });

// Every process in a Chromium process group whose leader uses the temp dir of
// the auto-qa CLI with this pid. Found independently of auto-qa's own sweep.
const browsersOf = (cliPid: number) => {
  const all = processes();
  const leaders = all
    .filter(
      (p) =>
        p.pid === p.pgid &&
        p.cmdline.includes("ms-playwright") &&
        p.cmdline.includes(`/auto-qa-${cliPid}-`)
    )
    .map((p) => p.pid);
  return all.filter((p) => leaders.includes(p.pgid)).map((p) => p.pid);
};

const alive = (pids: Iterable<number>) =>
  processes()
    .filter((p) => p.state !== "Z" && [...pids].includes(p.pid))
    .map((p) => p.pid);

const autoQa = (...args: string[]) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd: app });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const browsers = new Set<number>();
  const watcher = setInterval(
    () => browsersOf(child.pid!).forEach((pid) => browsers.add(pid)),
    50
  );
  const exited = once(child, "close").then(([code]) => {
    clearInterval(watcher);
    return { code: code as number | null, output };
  });
  const browserStarted = async () => {
    while (browsers.size === 0) await sleep(50);
  };
  return { child, browsers, exited, browserStarted };
};

const manifestOf = (output: string) => {
  const path = /auto-qa: manifest (\S+)/.exec(output)?.[1];
  if (path === undefined) throw new Error(`no manifest in output:\n${output}`);
  return JSON.parse(readFileSync(join(app, path), "utf8")) as {
    tests: Record<string, string | null>[];
  };
};

const ownedTmpDirs = (cliPid: number) =>
  readdirSync(tmpdir()).filter((name) =>
    new RegExp(`^auto-qa-${cliPid}-\\d+$`).test(name)
  );

test("writes evidence and a manifest for passing and failing tests, leaving no browsers", async () => {
  const run = autoQa("run", "app.spec.ts", "--base-url", baseUrl);
  const { code, output } = await run.exited;

  expect(code).toBe(1);
  const { tests } = manifestOf(output);
  expect(tests.map((t) => [t.title, t.status])).toEqual([
    ["shows the greeting", "passed"],
    ["finds a missing button", "failed"],
    ["is not @prod-safe-ish", "passed"],
    ["uses the auto-qa base URL @prod-safe", "passed"],
  ]);
  expect(tests[0]?.error).toBeNull();
  expect(tests[1]?.error).toContain("Missing");
  for (const t of tests) {
    expect(t.file).toBe("app.spec.ts");
    for (const evidence of [t.screenshot, t.trace, t.ariaSnapshot])
      expect(existsSync(join(app, evidence!))).toBe(true);
  }
  expect(readFileSync(join(app, tests[0]!.ariaSnapshot!), "utf8")).toContain(
    'heading "Hello"'
  );

  expect(run.browsers.size).toBeGreaterThan(0);
  expect(alive(run.browsers)).toEqual([]);
  expect(ownedTmpDirs(run.child.pid!)).toEqual([]);
});

test("kills the browsers of an interrupted run", async () => {
  const run = autoQa("run", "hang.spec.ts", "--base-url", baseUrl);
  await run.browserStarted();
  run.child.kill("SIGINT");
  const { code, output } = await run.exited;

  expect(code).toBe(130);
  expect(manifestOf(output).tests.map((t) => t.status)).toEqual([
    "interrupted",
  ]);
  expect(alive(run.browsers)).toEqual([]);
  expect(ownedTmpDirs(run.child.pid!)).toEqual([]);
});

test("requires --allow-remote for a remote base URL and then runs only @prod-safe tests", async () => {
  const refused = await autoQa(
    "run",
    "app.spec.ts",
    "--base-url",
    "https://qa.invalid"
  ).exited;
  expect(refused.code).toBe(2);
  expect(refused.output).toContain("--allow-remote");
  const terminated = await autoQa(
    "run",
    "app.spec.ts",
    "--base-url",
    "https://qa.invalid",
    "--allow-remote",
    "--"
  ).exited;
  expect(terminated.code).toBe(2);

  const { code, output } = await autoQa(
    "run",
    "app.spec.ts",
    "--base-url",
    "https://qa.invalid",
    "--allow-remote"
  ).exited;
  expect(code).toBe(0);
  expect(manifestOf(output).tests.map((t) => [t.title, t.status])).toEqual([
    ["uses the auto-qa base URL @prod-safe", "passed"],
  ]);
});

test("cleanup kills orphaned browsers but spares live runs, unowned processes and evidence", async () => {
  const orphaned = autoQa("run", "hang.spec.ts", "--base-url", baseUrl);
  const live = autoQa("run", "hang.spec.ts", "--base-url", baseUrl);
  await Promise.all([orphaned.browserStarted(), live.browserStarted()]);
  orphaned.child.kill("SIGKILL");
  await once(orphaned.child, "exit"); // The orphaned runner keeps its stdout open.
  // Merely mentioning an owned temp dir does not make a process or dir owned.
  const [owned] = ownedTmpDirs(orphaned.child.pid!);
  const lookalike = join(tmpdir(), `${owned}-notes`);
  mkdirSync(lookalike);
  const unowned = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 300_000)", join(tmpdir(), owned!)],
    { detached: true, stdio: "ignore" }
  );
  onTestFinished(async () => {
    unowned.kill();
    live.child.kill("SIGINT");
    await live.exited;
    rmSync(lookalike, { recursive: true, force: true });
  });
  const evidence = join(app, ".auto-qa/runs/kept/manifest.json");
  mkdirSync(join(evidence, ".."), { recursive: true });
  writeFileSync(evidence, "{}");
  expect(alive(orphaned.browsers)).not.toEqual([]);

  const { code, output } = await autoQa("cleanup").exited;

  expect(code).toBe(0);
  expect(output).toMatch(
    /killed [1-9]\d* leftover processes, removed [1-9]\d* temp dirs/
  );
  expect(alive(orphaned.browsers)).toEqual([]);
  expect(ownedTmpDirs(orphaned.child.pid!)).toEqual([]);
  expect(alive(live.browsers)).not.toEqual([]);
  expect(alive([unowned.pid!])).toEqual([unowned.pid]);
  expect(existsSync(evidence)).toBe(true);
  expect(existsSync(lookalike)).toBe(true);
});
