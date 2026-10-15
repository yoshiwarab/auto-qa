import { test as base } from "@playwright/test";
import { writeFileSync } from "node:fs";

export { expect } from "@playwright/test";

// Specs import { test, expect } from "auto-qa/test" to get auto-qa's base URL
// plus a final screenshot and accessibility snapshot of every page they use.
export const test = base.extend({
  screenshot: "on",
  baseURL: async ({ baseURL }, use) =>
    use(process.env.AUTO_QA_BASE_URL ?? baseURL),
  page: async ({ page }, use, testInfo) => {
    await use(page);
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
});
