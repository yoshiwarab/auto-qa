import { test } from "@playwright/test";

test("waits until interrupted", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.waitForTimeout(120_000);
});
