import { existsSync, mkdirSync, writeFileSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

export const isLocal = (url: string) => {
  const host = new URL(url).hostname;
  return (
    ["localhost", "127.0.0.1", "[::1]"].includes(host) ||
    host.endsWith(".localhost")
  );
};

// Loaded by `playwright test` itself; guards base URLs and writes the manifest.
export default class ManifestReporter implements Reporter {
  private tests = new Map<string, Record<string, string | null>>();

  // Runs before any test. Specs that import plain @playwright/test use their
  // project's baseURL, so every project must stay local or match --base-url.
  onBegin(config: FullConfig) {
    const allowed = new URL(process.env.AUTO_QA_BASE_URL!).origin;
    for (const { name, use } of config.projects) {
      if (!use.baseURL || isLocal(use.baseURL)) continue;
      if (new URL(use.baseURL).origin === allowed) continue;
      writeSync(
        2,
        `auto-qa: project "${name}" uses baseURL ${use.baseURL}, which is neither local nor --base-url\n`
      );
      process.exit(2);
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const evidence = (name: string) => {
      const path = result.attachments.find(
        (attachment) => attachment.name === name
      )?.path;
      return path && existsSync(path) ? relative(process.cwd(), path) : null;
    };
    // Keyed by test, so a retry replaces the earlier attempt.
    this.tests.set(test.id, {
      title: test.titlePath().slice(3).join(" › "),
      file: relative(process.cwd(), test.location.file),
      status: result.status,
      error: stripVTControlCharacters(result.error?.message ?? "") || null,
      screenshot: evidence("screenshot"),
      trace: evidence("trace"),
      ariaSnapshot: evidence("aria-snapshot"),
    });
  }

  onEnd(result: FullResult) {
    const manifest = join(process.env.AUTO_QA_RUN_DIR!, "manifest.json");
    const tests = [...this.tests.values()];
    mkdirSync(process.env.AUTO_QA_RUN_DIR!, { recursive: true });
    writeFileSync(
      manifest,
      `${JSON.stringify({ status: result.status, tests }, null, 2)}\n`
    );
    console.log(`auto-qa: manifest ${relative(process.cwd(), manifest)}`);
  }
}
