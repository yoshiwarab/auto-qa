import { expect, test } from "auto-qa/test";

test("passes on retry", () => {
  expect(test.info().retry).toBe(1);
});
