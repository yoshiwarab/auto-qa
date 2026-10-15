import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

// Loaded by `playwright test` itself; writes the run's manifest and summary.
export default class ManifestReporter implements Reporter {
  private tests: Record<string, string | null>[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    const evidence = (name: string) => {
      const path = result.attachments.find(
        (attachment) => attachment.name === name
      )?.path;
      return path && existsSync(path) ? relative(process.cwd(), path) : null;
    };
    this.tests.push({
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
    mkdirSync(process.env.AUTO_QA_RUN_DIR!, { recursive: true });
    writeFileSync(
      manifest,
      `${JSON.stringify({ status: result.status, tests: this.tests }, null, 2)}\n`
    );
    if (this.tests.some((test) => test.ariaSnapshot === null)) {
      console.log(
        `  some tests lack screenshots/accessibility snapshots: import { test } from "auto-qa/test"`
      );
    }
    console.log(`auto-qa: manifest ${relative(process.cwd(), manifest)}`);
  }
}
