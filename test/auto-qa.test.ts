import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    { encoding: "utf8", maxBuffer: 1 << 28 }
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

const autoQaIn = (cwd: string, ...args: string[]) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd });
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

const autoQa = (...args: string[]) => autoQaIn(app, ...args);

type Manifest = {
  tests: {
    title: string;
    file: string;
    status: string;
    attempts: {
      status: string;
      error: string | null;
      attachments: { name: string; path: string }[];
    }[];
  }[];
};

const manifestOf = (output: string) => {
  const path = /auto-qa: manifest (\S+)/.exec(output)?.[1];
  if (path === undefined) throw new Error(`no manifest in output:\n${output}`);
  return { path, ...(JSON.parse(readFileSync(path, "utf8")) as Manifest) };
};

// A test's final-attempt attachments by name.
const evidenceOf = (t: Manifest["tests"][number]) =>
  Object.fromEntries(
    t.attempts.at(-1)!.attachments.map((a) => [a.name, a.path])
  );

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
  const [greeting, missing] = tests;
  expect(greeting!.attempts[0]!.error).toBeNull();
  expect(missing!.attempts[0]!.error).toContain("Missing");
  expect(Object.keys(evidenceOf(greeting!)).sort()).toEqual([
    "aria-snapshot",
    "screenshot",
    "trace",
  ]);
  expect(evidenceOf(missing!)).toHaveProperty("error-context");
  for (const t of [greeting!, missing!]) {
    expect(t.file).toBe("app.spec.ts");
    for (const path of Object.values(evidenceOf(t)))
      expect(existsSync(path)).toBe(true);
  }
  expect(
    readFileSync(evidenceOf(greeting!)["aria-snapshot"]!, "utf8")
  ).toContain('heading "Hello"');

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

test("points plain @playwright/test specs at --base-url", async () => {
  const { code, output } = await autoQa(
    "run",
    "plain.spec.ts",
    "--base-url",
    baseUrl
  ).exited;
  expect(code, output).toBe(0);
});

test("refuses, before any test runs, a project with another baseURL or browser", async () => {
  for (const [config, reason] of [
    ["prod.config.ts", "https://prod.invalid"],
    ["firefox.config.ts", "firefox"],
  ]) {
    const { code, output } = await autoQa(
      "run",
      "plain.spec.ts",
      "--config",
      config!,
      "--base-url",
      baseUrl
    ).exited;

    expect(code).toBe(2);
    expect(output).toContain(reason);
    expect(output).not.toContain("plain spec ran");
  }
});

test("checks only the projects selected for the run", async () => {
  const { code, output } = await autoQa(
    "run",
    "plain.spec.ts",
    "--config",
    "firefox.config.ts",
    "--project",
    "chromium",
    "--base-url",
    baseUrl
  ).exited;
  expect(code, output).toBe(0);
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

test("records every attempt across retries", async () => {
  const { code, output } = await autoQa(
    "run",
    "retry.spec.ts",
    "--retries=1",
    "--base-url",
    baseUrl
  ).exited;

  expect(code).toBe(0);
  const { tests } = manifestOf(output);
  expect(tests.map((t) => [t.title, t.status])).toEqual([
    ["passes on retry", "passed"],
  ]);
  expect(tests[0]!.attempts.map((a) => a.status)).toEqual(["failed", "passed"]);
});

test("writes the run under --out", async () => {
  const out = mkdtempSync(join(tmpdir(), "qa-out-"));
  onTestFinished(() => rmSync(out, { recursive: true, force: true }));
  const { code, output } = await autoQa(
    "run",
    "plain.spec.ts",
    "--out",
    out,
    "--base-url",
    baseUrl
  ).exited;

  expect(code, output).toBe(0);
  expect(dirname(dirname(manifestOf(output).path))).toBe(out);
});

test("runs --scratch specs with its own Playwright in a project without one, leaving the project untouched", async () => {
  const project = mkdtempSync(join(tmpdir(), "qa-project-"));
  const specs = mkdtempSync(join(tmpdir(), "qa-specs-"));
  onTestFinished(() => {
    for (const dir of [project, specs]) rmSync(dir, { recursive: true });
  });
  writeFileSync(join(project, "package.json"), '{ "name": "no-playwright" }\n');
  const spec = join(specs, "greeting.spec.ts");
  writeFileSync(
    spec,
    `import { expect, test } from "@playwright/test";
test("greets", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading")).toHaveText("Hello");
});
`
  );
  const contents = () =>
    readdirSync(project, { recursive: true, encoding: "utf8" })
      .sort()
      .map((name) => {
        const path = join(project, name);
        return [
          name,
          statSync(path).isFile() ? readFileSync(path, "utf8") : "",
        ];
      });
  const before = contents();

  const refused = await autoQaIn(project, "run", spec, "--base-url", baseUrl)
    .exited;
  expect(refused.code).toBe(2);
  expect(refused.output).toContain("--scratch");

  const run = autoQaIn(
    project,
    "run",
    "--scratch",
    spec,
    "--base-url",
    baseUrl
  );
  const { code, output } = await run.exited;
  expect(code, output).toBe(0);
  const { path, tests } = manifestOf(output);
  onTestFinished(() => rmSync(dirname(path), { recursive: true }));
  expect(path.startsWith(join(tmpdir(), "auto-qa-runs"))).toBe(true);
  expect(tests.map((t) => [t.title, t.status])).toEqual([["greets", "passed"]]);
  expect(existsSync(evidenceOf(tests[0]!).trace!)).toBe(true);
  expect(contents()).toEqual(before);
  expect(alive(run.owned.keys())).toEqual([]);
  expect(ownedTmpDirs(run.child.pid!)).toEqual([]);
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
