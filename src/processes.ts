import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Each run owns a temp dir named after its owner process (pid + start time).
// Two markers, both visible to `ps` on Linux and macOS, prove ownership:
// Chromium's --user-data-dir lies inside that dir, and the dir's `runner` file
// names the detached Playwright runner whose process group holds the workers.
const ownedPrefix = () => join(tmpdir(), "auto-qa-");

const readFile = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const processes = () =>
  execFileSync(
    "ps",
    "-A -ww -o pid= -o pgid= -o stat= -o lstart= -o args=".split(" "),
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }
  )
    .split("\n")
    .flatMap((line) => {
      const [, pid, pgid, stat, start, args] =
        /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(
          line
        ) ?? [];
      if (pid === undefined || stat!.startsWith("Z")) return [];
      const id = `${pid}-${start!.replace(/\W/g, "")}`;
      return [{ pid: +pid, pgid: +pgid!, id, args: ` ${args}` }];
    });

// The process's identity (pid + start time), which survives pid reuse.
export const processId = (pid: number) =>
  processes().find((p) => p.pid === pid)?.id ?? "";

export const runTmpDir = (owner: string) => ownedPrefix() + owner;

export const recordRunner = (owner: string, pid: number) =>
  writeFileSync(join(runTmpDir(owner), "runner"), processId(pid));

const ownedToken = (text: string, key = "") =>
  text.split(key + ownedPrefix())[1]?.match(/^\d+-\w+(?=$|\/)/)?.[0];

export const kill = (target: number, signal: NodeJS.Signals) => {
  try {
    process.kill(target, signal);
  } catch {
    // Already gone.
  }
};

// The temp dirs of `owner`, or of every dead owner, and the processes they own
// (negative for a process group whose leader is owned).
const owned = (owner?: string) => {
  const all = processes();
  const live = new Set(all.map((p) => p.id));
  const matches = (token?: string) =>
    token !== undefined &&
    (owner !== undefined ? token === owner : !live.has(token));
  const dirs = readdirSync(tmpdir())
    .map((name) => join(tmpdir(), name))
    .filter((dir) => matches(ownedToken(dir)));
  const runners = new Set(dirs.map((dir) => readFile(join(dir, "runner"))));
  const targets = all
    .filter(
      (p) =>
        runners.has(p.id) || matches(ownedToken(p.args, " --user-data-dir="))
    )
    .map((p) => (p.pid === p.pgid ? -p.pid : p.pid));
  return { dirs, targets };
};

export const cleanup = async (owner?: string) => {
  const killed = new Set<number>();
  for (let attempt = 0; ; attempt++) {
    const { dirs, targets } = owned(owner);
    if (targets.length === 0) {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      return { processes: killed.size, dirs: dirs.length };
    }
    if (attempt === 50)
      throw new Error(`processes survived SIGKILL: ${targets.join(" ")}`);
    for (const target of targets) {
      killed.add(target);
      kill(target, "SIGKILL");
    }
    await sleep(100);
  }
};
