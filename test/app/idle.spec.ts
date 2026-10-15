import { test } from "@playwright/test";

test("idles without a page", async () => {
  test.setTimeout(120_000);
  await new Promise((resolve) => setTimeout(resolve, 120_000));
});
