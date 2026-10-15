import { test as base } from "@playwright/test";
import { writeFileSync } from "node:fs";

export { expect } from "@playwright/test";

// Specs import { test, expect } from "auto-qa/test" to get auto-qa's base URL
// plus a final screenshot and accessibility snapshot for every test.
export const test = base.extend<{ autoQaEvidence: void }>({
  screenshot: "on",
  baseURL: async ({ baseURL }, use) =>
    use(process.env.AUTO_QA_BASE_URL ?? baseURL),
  autoQaEvidence: [
    async ({ page }, use, testInfo) => {
      await use();
      const aria = await page
        .locator("body")
        .ariaSnapshot({ timeout: 5000 })
        .catch(() => null);
      if (aria === null) return;
      writeFileSync(testInfo.outputPath("aria-snapshot.yml"), aria);
      await testInfo.attach("aria-snapshot", {
        path: testInfo.outputPath("aria-snapshot.yml"),
        contentType: "text/yaml",
      });
    },
    { auto: true },
  ],
});
