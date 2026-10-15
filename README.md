# auto-qa

auto-qa runs a project's own Playwright specs, captures evidence for every
test, and makes sure no browser outlives the run. It works on Linux and
macOS, finding processes with `ps`.

## Commands

```bash
auto-qa run [playwright test args...] --base-url <url> [--allow-remote]
```

Runs `playwright test` from the project's `@playwright/test`, Chromium only. It
records a trace for every test, plus a final screenshot and accessibility
snapshot of any page the test used. Evidence goes to `.auto-qa/runs/<id>/`. The
`manifest.json` there lists each test's title, file, status, error and evidence
paths, taken from its final attempt when it was retried. Playwright and its
browsers run in their own process groups under a private temp dir. They are
killed when the run ends, including on Ctrl-C or SIGTERM.

Tests navigate relative to `--base-url`. A project may set `baseURL` only to
that same origin; any other `baseURL`, or a non-Chromium project, stops the run
before a test starts.

Local means `localhost`, `*.localhost`, `127.0.0.1` or `[::1]`. A non-local
`--base-url` requires `--allow-remote`. Such a run passes
`--grep @prod-safe --no-deps`, so only tests tagged exactly `@prod-safe` run,
with no setup projects. Your own `--grep` is replaced, and `--` is rejected.
Your config's `webServer` and `globalSetup` still run, so keep them safe for
production.

```bash
auto-qa cleanup
```

Kills browser and Playwright processes left behind by auto-qa runs whose owner
has died (for example, one killed with SIGKILL), and deletes their temp
profiles. A run's processes are those with an argument pointing into its temp
dir (`$TMPDIR/auto-qa-*`): Chromium's `--user-data-dir`, or the
`--diagnostic-dir` Node flag that the Playwright runner and its workers carry.
Processes are never matched by name. Active runs and `.auto-qa/runs` evidence
are left alone.

## How agents should use it

Follow [`skills/qa/SKILL.md`](skills/qa/SKILL.md). To install it as a skill,
copy or symlink `skills/qa/` into your project's `.claude/skills/` or
`.cursor/skills/`.

Install auto-qa itself as a dev dependency next to `@playwright/test` (a peer
dependency).

## Development

```bash
fnm exec --using 22 pnpm install
fnm exec --using 22 pnpm check   # lint, build, typecheck, tests
```

The pre-commit hook runs `pnpm check` and keeps `src/` under 450 lines.
