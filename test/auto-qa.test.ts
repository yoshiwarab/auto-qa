import { execFileSync, spawn } from "node:child_process";
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

// Every process via `ps`, which reads the same way on Linux and macOS.
const processes = () =>
  execFileSync(
    "ps",
    ["-A", "-ww", "-o", "pid=", "-o", "pgid=", "-o", "stat=", "-o", "args="],
    {
      encoding: "utf8",
    }
  )
    .split("\n")
    .flatMap((line) => {
      const [, pid, pgid, state, args] =
        /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line) ?? [];
      return pid
        ? [{ pid: +pid, pgid: +pgid!, state: state!, args: args! }]
        : [];
    });

// Every process in a group led by this CLI's Playwright runner (its run dir
// ends in the CLI pid) or by a Chromium using its temp dir, with its args.
// Found independently of auto-qa's own sweep.
const processesOf = (cliPid: number) => {
  const all = processes();
  const leaders = all
    .filter(
      (p) =>
        p.pid === p.pgid &&
        (p.args.includes(`Z-${cliPid} `) ||
          (p.args.includes("ms-playwright") &&
            p.args.includes(`/auto-qa-${cliPid}-`)))
    )
    .map((p) => p.pid);
  return all.filter((p) => leaders.includes(p.pgid));
};

const alive = (pids: Iterable<number>) => {
  const wanted = new Set(pids);
  return processes()
    .filter((p) => !p.state.startsWith("Z") && wanted.has(p.pid))
    .map((p) => p.pid);
};

const autoQa = (...args: string[]) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd: app });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const owned = new Map<number, string>();
  const watcher = setInterval(() => {
    for (const p of processesOf(child.pid!)) owned.set(p.pid, p.args);
  }, 100);
  const exited = once(child, "close").then(([code]) => {
    clearInterval(watcher);
    return { code: code as number | null, output };
  });
  // Waits until `count` of the run's processes have `marker` in their args.
  const started = async (marker = "ms-playwright", count = 1) => {
    const matching = () =>
      [...owned.values()].filter((args) => args.includes(marker)).length;
    while (matching() < count) await sleep(50);
  };
  return { child, owned, exited, started };
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
    new RegExp(`^auto-qa-${cliPid}-\\w+$`).test(name)
  );

test("writes evidence and a manifest for passing and failing tests, leaving no processes", async () => {
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
  for (const t of tests.slice(0, 2)) {
    expect(t.file).toBe("app.spec.ts");
    for (const evidence of [t.screenshot, t.trace, t.ariaSnapshot])
      expect(existsSync(join(app, evidence!))).toBe(true);
  }
  // Tests that never touch a page don't get one forced on them.
  for (const t of tests.slice(2))
    expect([t.screenshot, t.ariaSnapshot]).toEqual([null, null]);
  expect(readFileSync(join(app, tests[0]!.ariaSnapshot!), "utf8")).toContain(
    'heading "Hello"'
  );

  const seen = [...run.owned.values()];
  expect(seen.some((args) => args.includes("ms-playwright"))).toBe(true);
  expect(seen.some((args) => args.includes("--output="))).toBe(true);
  expect(alive(run.owned.keys())).toEqual([]);
  expect(ownedTmpDirs(run.child.pid!)).toEqual([]);
});

test("kills every process of an interrupted run", async () => {
  const run = autoQa("run", "hang.spec.ts", "--base-url", baseUrl);
  await run.started();
  run.child.kill("SIGINT");
  const { code, output } = await run.exited;

  expect(code).toBe(130);
  expect(manifestOf(output).tests.map((t) => t.status)).toEqual([
    "interrupted",
  ]);
  expect(alive(run.owned.keys())).toEqual([]);
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

test("refuses a project whose baseURL is neither local nor --base-url, before any test runs", async () => {
  const { code, output } = await autoQa(
    "run",
    "plain.spec.ts",
    "--config",
    "prod.config.ts",
    "--base-url",
    baseUrl
  ).exited;

  expect(code).toBe(2);
  expect(output).toContain("https://prod.invalid");
  expect(output).not.toContain("plain spec ran");
});

test("treats [::1] and *.localhost as local", async () => {
  for (const url of ["http://[::1]:9", "http://app.localhost:9"]) {
    const { code, output } = await autoQa(
      "run",
      "app.spec.ts",
      "--grep",
      "base URL",
      "--base-url",
      url
    ).exited;
    expect(code, output).toBe(0);
  }
});

test("keeps one manifest entry per test across retries", async () => {
  const { code, output } = await autoQa(
    "run",
    "retry.spec.ts",
    "--retries=1",
    "--base-url",
    baseUrl
  ).exited;

  expect(code).toBe(0);
  expect(manifestOf(output).tests.map((t) => [t.title, t.status])).toEqual([
    ["passes on retry", "passed"],
  ]);
});

test("cleanup kills orphaned runs but spares live runs, unowned processes and evidence", async () => {
  const orphaned = autoQa("run", "hang.spec.ts", "--base-url", baseUrl);
  // Without a browser, only the recorded runner identifies this orphan.
  const idle = autoQa("run", "idle.spec.ts", "--base-url", baseUrl);
  const live = autoQa("run", "hang.spec.ts", "--base-url", baseUrl);
  await Promise.all([
    orphaned.started(),
    idle.started("node", 2),
    live.started(),
  ]);
  for (const run of [orphaned, idle]) {
    run.child.kill("SIGKILL");
    await once(run.child, "exit"); // The orphaned runner keeps its stdout open.
  }
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
  expect(alive(orphaned.owned.keys())).not.toEqual([]);
  expect(alive(idle.owned.keys())).toHaveLength(2);

  const { code, output } = await autoQa("cleanup").exited;

  expect(code).toBe(0);
  expect(output).toMatch(
    /killed [1-9]\d* leftover processes, removed [1-9]\d* temp dirs/
  );
  expect(alive(orphaned.owned.keys())).toEqual([]);
  expect(alive(idle.owned.keys())).toEqual([]);
  expect(ownedTmpDirs(orphaned.child.pid!)).toEqual([]);
  expect(ownedTmpDirs(idle.child.pid!)).toEqual([]);
  expect(alive(live.owned.keys())).not.toEqual([]);
  expect(alive([unowned.pid!])).toEqual([unowned.pid]);
  expect(existsSync(evidence)).toBe(true);
  expect(existsSync(lookalike)).toBe(true);
});
