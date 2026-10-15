---
name: qa
description: Verify a UI or other user-visible change in a web app in a real browser with auto-qa before claiming it works. Use it to prove a fix works in the browser, or when writing or maintaining end-to-end (e2e) Playwright specs.
---

# QA with auto-qa

auto-qa runs Playwright specs, records a screenshot, accessibility snapshot and
trace for each test, and makes sure no browser outlives the run. Use it after
any change a user could see, before you say it works. Skip it for pure
refactors that existing tests already cover.

Run it as `npx auto-qa` only if auto-qa is installed in the project. Otherwise
use `npx github:yoshiwarab/auto-qa`; never a bare `npx auto-qa`, which would
fetch whatever package has that name on npm. Below, `auto-qa` means whichever
applies. It brings its own Playwright and Chromium; install nothing.

## 1. Write a spec

If the project depends on `@playwright/test`, write `qa/<change>.spec.ts` in its
test dir (`testDir` in `playwright.config.*`, else the project root). Otherwise
write `$TMPDIR/<change>.spec.ts` and touch nothing in the repo. The name must
end in `.spec.ts`.

```ts
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";

test.use({ screenshot: "on" });
test.afterEach(async ({ page }, testInfo) => {
  const path = testInfo.outputPath("aria-snapshot.yml");
  writeFileSync(path, await page.locator("body").ariaSnapshot());
  await testInfo.attach("aria-snapshot", { path });
});

test("saving a draft lists it", async ({ page }) => {
  await page.goto("/drafts");
  await page.getByLabel("Title").fill("Q3 plan");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("link", { name: "Q3 plan" })).toBeVisible();
});
```

- Keep the `test.use` and `test.afterEach` lines: they record the evidence.
- Use relative URLs in `page.goto`; auto-qa supplies the base URL.
- Locate by role or label (`getByRole`, `getByLabel`). Fall back to `getByText`
  only when nothing else fits. Never use CSS, XPath or `nth-child`.
- Assert behavior or state with at least one `expect`. A screenshot is
  evidence, not an assertion.
- Drive the real user path (click, type, submit). Never call internal setters
  or seed state through test-only endpoints. If the action has a side effect,
  assert it, for example by reloading and checking it persisted.
- Wait with web-first assertions, never `waitForTimeout`.

## 2. Run it

```bash
auto-qa run <test dir>/qa/<change>.spec.ts --base-url <URL>     # in the repo
auto-qa run --scratch $TMPDIR/<change>.spec.ts --base-url <URL> # otherwise
```

Find the URL; don't guess it:

1. Check what is already running: `lsof -nP -iTCP -sTCP:LISTEN`. A listener is
   this project's if its working directory is the project
   (`lsof -a -p <pid> -d cwd`).
2. Otherwise read the dev script in `package.json` and its port. With no dev
   script, serve the static files.
3. If `playwright.config.*` sets `baseURL`, pass exactly that URL. auto-qa
   refuses a run whose project `baseURL` differs from `--base-url`.

Never start a second instance on top of the user's. If you start one, run it
in the background and wait until the URL responds. When done, stop it and
confirm the port is free (`lsof -nP -iTCP:<port> -sTCP:LISTEN`). The pid you
started is often a wrapper (`npm run dev`, a subshell); the server outlives it.

auto-qa supports Chromium only; if the config has other browser projects, add
`--project <the Chromium project>`. Exit codes: 0 all passed, 1 a test failed,
2 auto-qa refused the run (its message says why), 130 interrupted.

## 3. Read the evidence before claiming a pass

The output ends with `auto-qa: manifest <path>`. In that `manifest.json`, each
test has a `status` and its `attempts`, each with an `error` and
`attachments`: `screenshot`, `aria-snapshot` and `trace`, plus `error-context`
on failure.

- For every test that matters to the change, open the screenshot and read the
  accessibility snapshot, which lists roles, names and text.
- Report what you observed ("the list shows 'Q3 plan' after a reload"), not
  just "passed". A test that passed only on a retry is flaky; say so.
- A green run whose screenshot shows the wrong page, an error banner or a
  stale state is a failure. Treat it as one.

## 4. When it fails

Use the error, screenshot and snapshot to decide which is wrong:

- App wrong: fix the app and rerun. Never weaken or delete an assertion to get
  green.
- Spec wrong: fix only locators, waits or navigation, and say in your report
  that you changed the spec and why.

## 5. Afterwards

- Delete the spec. Move it into the project's e2e dir (`e2e/` unless one
  already exists) only when the user explicitly asks; auto-qa being installed
  is not that request. Extend an existing spec for the same feature rather than
  adding a near-duplicate.
- Put `@prod-safe` in a test's title only if it is read-only or writes only to
  a dedicated test account. A non-local `--base-url` needs `--allow-remote`,
  and then only `@prod-safe` tests run.
- If a run was killed or looks stuck, run `auto-qa cleanup`. It removes only
  auto-qa's leftover browsers and temp profiles. Never kill browsers by name
  (`pkill chrome`); they may be the user's.
