# auto-qa

auto-qa runs a project's own Playwright specs, captures evidence for every
test, and makes sure no browser outlives the run. Linux only (it reads
`/proc`).

## Commands

```bash
auto-qa run [playwright test args...] --base-url <url> [--allow-remote]
```

Runs `playwright test` from the project's `@playwright/test`. It records a
trace, a final screenshot and an accessibility snapshot for every test.
Evidence goes to `.auto-qa/runs/<id>/`. The `manifest.json` there lists each
test's title, file, status, error and evidence paths. Playwright and its
browsers run in their own process groups under a private temp dir. They are
killed when the run ends, including on Ctrl-C or SIGTERM.

A non-local `--base-url` (anything but `localhost` or `127.0.0.1`) requires
`--allow-remote`. Such a run passes `--grep @prod-safe --no-deps`, so only tests
tagged exactly `@prod-safe` run, with no setup projects. Your own `--grep` is
replaced, and `--` is rejected. Your config's `webServer` and `globalSetup`
still run, so keep them safe for production.

```bash
auto-qa cleanup
```

Kills browser and Playwright processes left behind by auto-qa runs whose owner
has died (for example, one killed with SIGKILL). It also deletes their temp
profiles. It finds them by the run's temp dir path (`$TMPDIR/auto-qa-*`), never
by process name. Active runs and `.auto-qa/runs` evidence are left alone.

## How agents should use it

1. Write ordinary Playwright specs, but import `{ test, expect }` from
   `"auto-qa/test"` and navigate with relative URLs (`page.goto("/")`).
2. Run `auto-qa run <spec files> --base-url <your dev server URL>`; tag
   tests that are safe to run against production (writes to a test user
   included) with `@prod-safe`. Remote runs can use their own `--config`.
3. Read the printed `manifest.json`, then open its screenshots, accessibility
   snapshots and traces (`npx playwright show-trace <trace.zip>`).

Install it as a dev dependency next to `@playwright/test` (a peer dependency).

## Development

```bash
fnm exec --using 22 pnpm install
fnm exec --using 22 pnpm check   # lint, build, typecheck, tests
```

The pre-commit hook runs `pnpm check` and keeps `src/` under 450 lines.
