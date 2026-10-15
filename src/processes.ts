import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Each run owns a private TMPDIR named after its owner process. Playwright's
// runner and workers inherit it as TMPDIR. Chromium overwrites its environ and
// joins its argv with spaces, but its group leader keeps --user-data-dir under
// that TMPDIR. Those two exact markers are the only things we kill by.
const ownedPrefix = () => join(tmpdir(), "auto-qa-");

const read = (path: string) => {
  try {
    return readFileSync(path, "latin1");
  } catch {
    return "";
  }
};

export const ownerToken = (pid = process.pid) => {
  const stat = read(`/proc/${pid}/stat`);
  return `${pid}-${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
};

export const ownerAlive = (token: string) =>
  ownerToken(Number(token.split("-")[0])) === token;

export const runTmpDir = (token: string) => ownedPrefix() + token;

// The owner token after `key` + an owned temp dir path, if `text` has one.
const ownedToken = (text: string, key = "") =>
  text.split(key + ownedPrefix())[1]?.match(/^\d+-\d+(?=$|\/|\0)/)?.[0];

export const kill = (target: number, signal: NodeJS.Signals) => {
  try {
    process.kill(target, signal);
  } catch {
    // Already gone, or not a group leader.
  }
};

const ownedPids = (matches: (token: string) => boolean) =>
  readdirSync("/proc").filter((pid) => {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
    const token =
      ownedToken(`\0${read(`/proc/${pid}/environ`)}`, "\0TMPDIR=") ??
      ownedToken(
        ` ${read(`/proc/${pid}/cmdline`)}`.replaceAll("\0", " "),
        " --user-data-dir="
      );
    return token !== undefined && matches(token);
  });

// Kills owned processes and the process groups they lead (Chromium's renderers
// live in its group), then deletes the matching temp dirs and their profiles.
export const cleanup = async (matches: (token: string) => boolean) => {
  const killed = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    const pids = ownedPids(matches);
    if (pids.length === 0) break;
    if (attempt === 50)
      throw new Error(`processes survived SIGKILL: ${pids.join(" ")}`);
    for (const pid of pids) {
      killed.add(pid);
      kill(-pid, "SIGKILL");
      kill(+pid, "SIGKILL");
    }
    await sleep(100);
  }
  const dirs = readdirSync(tmpdir())
    .map((name) => join(tmpdir(), name))
    .filter((dir) => {
      const token = ownedToken(dir);
      return token !== undefined && matches(token);
    });
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  return { processes: killed.size, dirs: dirs.length };
};
