import { expect, test } from "@playwright/test";

test("plain import", ({ baseURL }) => {
  console.log("plain spec ran");
  expect(baseURL).toBe(process.env.AUTO_QA_BASE_URL);
});
