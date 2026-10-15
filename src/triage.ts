import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { playwrightCli } from "./playwright.js";
import type { Test } from "./reporter.js";

const run = (command: string, args: string[]) =>
  spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 28 });

// The upstream branch (diffed from its merge base), or else the last commit.
const defaultBase = () =>
  run("git", ["rev-parse", "--verify", "--quiet", "@{upstream}"]).status === 0
    ? "@{upstream}"
    : "HEAD~1";

const fence = (text: string, lang = "") =>
  `\`\`\`${lang}\n${text.trimEnd()}\n\`\`\``;

// The facts for deciding whether failures are regressions, drift or flakes:
// every failing or flaky test with each attempt's error and evidence, and what
// changed since `base`, diffing only non-spec files (or why git couldn't say).
export const triage = (base = defaultBase(), manifestPath: string) => {
  const { tests } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    tests: Test[];
  };
  const failures = tests
    .filter((t) => t.attempts.some((a) => !/passed|skipped/.test(a.status)))
    .map((t) =>
      [
        `## ${t.status === "passed" ? "flaky" : t.status}: ${t.title} (${t.file})`,
        ...t.attempts.flatMap((a, i) => [
          `### Attempt ${i + 1}: ${a.status}`,
          ...(a.error ? [fence(a.error)] : []),
          a.attachments.map((x) => `- ${x.name}: ${x.path}`).join("\n"),
        ]),
      ].join("\n\n")
    );
  const git = (...args: string[]) => {
    const out = run("git", ["--no-pager", "-c", "color.ui=never", ...args]);
    return out.status === 0
      ? out.stdout
      : `git ${args[0]} failed: ${out.stderr}`;
  };
  const range = `${base}...HEAD`;
  const specs = [":(exclude,glob)**/*.spec.*", ":(exclude,glob)**/*.test.*"];
  const diff = git("diff", range, "--", ".", ...specs).split("\n");
  const path = join(dirname(manifestPath), "triage.md");
  const report = [
    `# auto-qa triage\n\nManifest: ${manifestPath}`,
    ...(failures.length ? failures : ["No failing or flaky tests."]),
    `## Commits and changes since ${base} (the diff leaves out specs)`,
    fence(git("log", "--oneline", `${base}..HEAD`)),
    fence(git("diff", "--stat", range)),
    fence(diff.slice(0, 400).join("\n") + (diff[400] ? "\n…" : ""), "diff"),
  ];
  writeFileSync(path, `${report.join("\n\n")}\n`);
  console.log(`auto-qa: triage ${path}`);
  return 0;
};

const assertion =
  /\bexpect\b|\.(?:not\.)?to(?:Be|Have|Match|Contain|Equal|Throw)/;

// The project's Playwright test dirs, from its own config.
const testDirs = () => {
  const list = run(process.execPath, [
    ...[playwrightCli(false), "test", "--list"],
    ...["--pass-with-no-tests", "--reporter=json"],
  ]);
  const { config } = JSON.parse(list.stdout) as {
    config: { projects: { testDir: string }[] };
  };
  return [...new Set(config.projects.map((p) => p.testDir))];
};

// The removed or changed lines of a diff that hold an assertion, as
// `file:line: text` with the line number on the old side.
const assertionLines = (diff: string) => {
  const found: string[] = [];
  let [file, line] = ["", 0];
  for (const text of diff.split("\n")) {
    if (text.startsWith("--- ")) file = text.slice(4);
    else if (text.startsWith("@@")) line = Number(/-(\d+)/.exec(text)![1]);
    else if (text.startsWith("-")) {
      if (assertion.test(text))
        found.push(`  ${file}:${line}: ${text.slice(1).trim()}`);
      line++;
    }
  }
  return found;
};

// Healing may change how a test finds things, never what it checks: fails
// when a line holding an assertion was changed or removed since `base`.
export const guard = (base = defaultBase(), paths: string[] = []) => {
  const diff = run("git", [
    ...["diff", "--no-color", "--no-prefix", "--unified=0"],
    ...["--merge-base", base, "--", ...(paths.length ? paths : testDirs())],
  ]);
  if (diff.status !== 0) throw new Error(diff.stderr);
  const changed = assertionLines(diff.stdout);
  if (changed.length === 0) return 0;
  console.error(
    [
      `auto-qa guard: assertions changed or removed since ${base} (line numbers as of ${base}):`,
      ...changed,
      "Healing may change how a test finds things, never what it checks.",
      "If this behavior change is intended, rerun with AUTO_QA_ALLOW_ASSERTION_CHANGES=1.",
    ].join("\n")
  );
  return process.env.AUTO_QA_ALLOW_ASSERTION_CHANGES === "1" ? 0 : 1;
};
