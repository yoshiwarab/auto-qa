import { expect, test } from "auto-qa/test";

test("shows the greeting", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading")).toHaveText("Hello");
});

test("finds a missing button", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Missing" })).toBeVisible({
    timeout: 500,
  });
});

test("is not @prod-safe-ish", () => {});

test("uses the auto-qa base URL @prod-safe", ({ baseURL }) => {
  expect(baseURL).toBe(process.env.AUTO_QA_BASE_URL);
});
