import { existsSync, mkdirSync, writeFileSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

export type Test = {
  title: string;
  file: string;
  status: string;
  attempts: {
    status: string;
    error: string | null;
    attachments: { name: string; path: string }[];
  }[];
};

// Loaded by `playwright test` itself; checks projects and writes the manifest.
export default class ManifestReporter implements Reporter {
  private tests = new Map<string, Test>();

  // Runs before any test. Playwright ignores errors thrown by reporters, so
  // every failure here, including an unparsable URL, exits the run instead.
  onBegin(_: FullConfig, suite: Suite) {
    try {
      const allowed = new URL(process.env.AUTO_QA_BASE_URL!).origin;
      // Only projects selected for this run (e.g. by --project) have suites.
      for (const { name, use } of suite.suites.map((s) => s.project()!)) {
        // Other browsers carry no profile marker for cleanup to find.
        if ((use.browserName ?? "chromium") !== "chromium")
          throw new Error(
            `project "${name}" uses ${use.browserName}; only Chromium is supported`
          );
        // Specs that import plain @playwright/test use this baseURL.
        if (use.baseURL && new URL(use.baseURL).origin !== allowed)
          throw new Error(
            `project "${name}" uses baseURL ${use.baseURL}, not --base-url ${allowed}`
          );
      }
    } catch (error) {
      writeSync(
        2,
        `auto-qa: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(2);
    }
  }

  // Every attempt is kept, so retries show up as flaky; the test's status is
  // its latest attempt's. Attachment paths are absolute.
  onTestEnd(test: TestCase, result: TestResult) {
    const entry = this.tests.get(test.id) ?? {
      title: test.titlePath().slice(3).join(" › "),
      file: relative(process.cwd(), test.location.file),
      status: result.status,
      attempts: [],
    };
    entry.status = result.status;
    entry.attempts.push({
      status: result.status,
      error: stripVTControlCharacters(result.error?.message ?? "") || null,
      attachments: result.attachments.flatMap(({ name, path }) =>
        path && existsSync(path) ? [{ name, path }] : []
      ),
    });
    this.tests.set(test.id, entry);
  }

  onEnd(result: FullResult) {
    const manifest = join(process.env.AUTO_QA_RUN_DIR!, "manifest.json");
    const tests = [...this.tests.values()];
    mkdirSync(process.env.AUTO_QA_RUN_DIR!, { recursive: true });
    writeFileSync(
      manifest,
      `${JSON.stringify({ status: result.status, tests }, null, 2)}\n`
    );
    // Lines that survive a caller's `grep "passed|failed"` or `tail -3`.
    const kind = (t: Test) =>
      t.status === "passed" && t.attempts.length > 1
        ? "flaky"
        : /passed|skipped/.test(t.status)
          ? t.status
          : "failed";
    const count = (k: string) => tests.filter((t) => kind(t) === k).length;
    for (const t of tests.filter((t) => /failed|flaky/.test(kind(t)))) {
      const error = t.attempts.find((a) => a.error)?.error ?? "";
      const lines = error
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 4);
      console.log(`auto-qa: ${kind(t)} "${t.title}": ${lines.join(" | ")}`);
    }
    if (tests.length === 0 && process.env.AUTO_QA_PROD_SAFE_ONLY)
      console.log(
        "auto-qa: no test ran: with --allow-remote only tests with @prod-safe in their title run"
      );
    console.log(
      `auto-qa: manifest ${manifest} (${count("passed")} passed, ${count("failed")} failed, ${count("flaky")} flaky)`
    );
  }
}
