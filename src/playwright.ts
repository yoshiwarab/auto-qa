import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

// The project's own Playwright CLI, or auto-qa's own copy.
export const playwrightCli = (own: boolean) => {
  try {
    return createRequire(
      own ? import.meta.url : resolve("package.json")
    ).resolve("@playwright/test/cli");
  } catch {
    throw new Error("this project has no @playwright/test; use --scratch");
  }
};

// The project's own Playwright, run from the project. For scratch specs,
// auto-qa's own copy instead, run from a throwaway test dir where the specs'
// `@playwright/test` imports resolve to that same copy. Never both: Playwright
// refuses to load a second copy of itself.
export const playwrightFor = (scratch: string[], workspace: string) => {
  const cli = playwrightCli(scratch.length > 0);
  // A no-op when the matching browser is already installed. Its stderr only
  // matters on failure; under npx it always warns about a missing project
  // install, which is expected for scratch runs.
  const install = [cli, "install", "--only-shell", "chromium"];
  const { status, stderr } = spawnSync(process.execPath, install, {
    stdio: ["ignore", "inherit", "pipe"],
  });
  if (status !== 0)
    throw new Error(
      `${stderr}\ncould not install Chromium: node ${install.join(" ")}`
    );

  if (scratch.length === 0) return { cli, cwd: process.cwd() };
  mkdirSync(workspace);
  symlinkSync(resolve(cli, "../../.."), join(workspace, "node_modules"));
  for (const spec of scratch)
    copyFileSync(spec, join(workspace, basename(spec)));
  return { cli, cwd: workspace };
};
