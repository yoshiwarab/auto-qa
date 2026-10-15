---
name: qa
description: Verify a UI or other user-visible change in a web app in a real browser with auto-qa before claiming it works. Use it to prove a fix works in the browser, or when writing or maintaining end-to-end (e2e) Playwright specs.
---

# QA with auto-qa

auto-qa runs Playwright specs, records a screenshot, accessibility snapshot and
trace for each test, and makes sure no browser outlives the run. Use it after
any change a user could see, before you say it works. Skip it for pure
refactors that existing tests already cover.

## 1. Write a spec

Create `qa/<short-change-name>.spec.ts` in the target project. If
`playwright.config.*` sets `testDir`, put `qa/` inside that dir instead.
Playwright only finds specs there.

```ts
import { expect, test } from "auto-qa/test";

test("saving a draft lists it", async ({ page }) => {
  await page.goto("/drafts");
  await page.getByLabel("Title").fill("Q3 plan");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("link", { name: "Q3 plan" })).toBeVisible();
});
```

- Import from `auto-qa/test`, not `@playwright/test`; without it you get no
  screenshot or accessibility snapshot.
- Use relative URLs in `page.goto`; auto-qa supplies the base URL.
- Locate by role or label (`getByRole`, `getByLabel`). Fall back to `getByText`
  only when nothing else fits. Never use CSS, XPath or `nth-child`.
- Assert behavior or state with at least one `expect`. A screenshot is
  evidence, not an assertion.
- Drive the real user path (click, type, submit). Never call internal setters,
  seed state through test-only endpoints, or poke the store.
- If the action has a side effect (saved data, a sent request, a changed
  count), assert it, for example by reloading and checking it persisted.
- Wait with web-first assertions (`await expect(locator).toBeVisible()`),
  never `waitForTimeout`.

## 2. Run it

```bash
npx auto-qa run qa/<file>.spec.ts --base-url <dev server URL>
```

Find the URL; don't guess it:

1. Check what is already running: `lsof -nP -iTCP -sTCP:LISTEN`. A listener is
   this project's if its working directory is the project
   (`lsof -a -p <pid> -d cwd`).
2. Otherwise read the dev script in `package.json` and its port (Vite defaults
   to 5173, Next to 3000). With no dev script, serve the static files.
3. If `playwright.config.*` sets `baseURL`, pass exactly that URL. auto-qa
   refuses a run whose project `baseURL` differs from `--base-url`.

Never start a second instance on top of the user's. If you start one, run it
in the background and wait until the URL responds. When done, stop it and
confirm the port is free (`lsof -nP -iTCP:<port> -sTCP:LISTEN`). The pid you
started is often a wrapper (`npm run dev`, a subshell); the server outlives it.

auto-qa supports Chromium only. If the config has other browser projects, add
`--project <the Chromium project>`.

Exit codes: 0 all passed, 1 a test failed, 2 auto-qa refused the run (its
message says why), 130 interrupted.

## 3. Read the evidence before claiming a pass

The output ends with `auto-qa: manifest <path>`. Open that `manifest.json`.
Each test has `status`, `error`, and the paths of its `screenshot`,
`ariaSnapshot` and `trace`, relative to where you ran auto-qa.

- For every test that matters to the change, open the screenshot and read the
  accessibility snapshot. The snapshot lists roles, names and text, so you can
  confirm wording and state.
- Report what you observed ("the list shows 'Q3 plan' after a reload"), not
  just "passed".
- A green run whose screenshot shows the wrong page, an error banner or a
  stale state is a failure. Treat it as one.

## 4. When it fails

Use the error, screenshot and snapshot to decide which is wrong:

- App wrong: fix the app and rerun. Never weaken or delete an assertion to get
  green.
- Spec wrong: fix only locators, waits or navigation, and say in your report
  that you changed the spec and why.

## 5. Keep or discard

- `qa/` is throwaway by default. If `.gitignore` doesn't cover it, suggest
  adding `qa/` to it.
- Promote a spec only when it guards lasting behavior that a regression would
  hurt. Move it into the project's e2e dir (`e2e/` unless one already exists).
- Before adding a spec there, extend an existing spec for the same feature
  instead of creating a near-duplicate. Keep the kept suite small.

## 6. Production

Put `@prod-safe` in a test's title only if it is read-only or writes only to a
dedicated test account. A non-local `--base-url` needs `--allow-remote`, and
then only `@prod-safe` tests run.

## 7. Stuck or killed runs

If a run was killed or looks stuck, run `npx auto-qa cleanup`. It removes only
auto-qa's leftover browsers and temp profiles. Never kill browsers by name
(`pkill chrome`); they may be the user's.

## Setup, if auto-qa is missing

```bash
npm install -D auto-qa @playwright/test
npx playwright install chromium
```
