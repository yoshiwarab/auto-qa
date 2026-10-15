import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Each run owns a temp dir named after its owner process (pid + start time).
// A process belongs to the run if one of its arguments points into that dir:
// Chromium's --user-data-dir, or the --diagnostic-dir Node flag that auto-qa
// gives the Playwright runner and its workers inherit. `ps` shows both on
// Linux and macOS.
const marker =
  / --(?:user-data-dir|diagnostic-dir)=[^ ]*\/auto-qa-(\d+-\w+)(?=[/ ]|$)/;

const processes = () =>
  execFileSync(
    "ps",
    "-A -ww -o pid= -o pgid= -o stat= -o lstart= -o args=".split(" "),
    {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }
  )
    .split("\n")
    .flatMap((line) => {
      const [, pid, pgid, stat, start, args] =
        /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(
          line
        ) ?? [];
      if (pid === undefined || stat!.startsWith("Z")) return [];
      const id = `${pid}-${start!.replace(/\W/g, "")}`;
      const owner = marker.exec(` ${args}`)?.[1];
      return [{ pid: +pid, pgid: +pgid!, id, owner }];
    });

// The process's pid and start second, which tell a reused pid apart.
export const processId = (pid: number) =>
  processes().find((p) => p.pid === pid)?.id ?? "";

export const runTmpDir = (owner: string) => join(tmpdir(), `auto-qa-${owner}`);

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
    .filter((name) => matches(/^auto-qa-(\d+-\w+)$/.exec(name)?.[1]))
    .map((name) => join(tmpdir(), name));
  const targets = all
    .filter((p) => matches(p.owner))
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
