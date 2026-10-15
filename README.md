# auto-qa

auto-qa runs Playwright specs, captures evidence for every test, and makes
sure no browser outlives the run. It works on Linux and macOS, finding
processes with `ps`.

It needs nothing installed in the project:

```bash
npx github:yoshiwarab/auto-qa run ...
```

## Commands

```bash
auto-qa run [playwright test args...] --base-url <url>
  [--scratch <spec file>]... [--out <dir>] [--allow-remote]
```

Without `--scratch`, it runs `playwright test` from the project's own
`@playwright/test`, with the project's config and test dir. With
`--scratch <file>`, it copies those spec files into a throwaway test dir and
runs them with auto-qa's own Playwright. The repo is never touched, and the
project needs no Playwright. Scratch specs are black-box browser tests: they
can import `@playwright/test`, but nothing from the project. Either way,
auto-qa installs the matching Chromium if it is missing.

It records a trace for every test. A spec that follows the template in the
skill adds a screenshot and accessibility snapshot. Evidence goes to
`<out>/<id>/`, where `--out` defaults to `.auto-qa/runs` in a project and to
`$TMPDIR/auto-qa-runs` for scratch runs. The printed `manifest.json` lists each
test's title, file and final status, and every attempt with its status, error
and attachments. Playwright and its browsers run in their own process groups
under a private temp dir. They are killed when the run ends, including on
Ctrl-C or SIGTERM.

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

## Installing it in a project

To pin a version, add it as a git dev dependency:

```bash
npm install -D github:yoshiwarab/auto-qa
```

Its `prepare` script builds `dist/` during install.

## Development

```bash
fnm exec --using 22 pnpm install
fnm exec --using 22 pnpm run setup   # install the Git hooks (`pnpm setup` is a pnpm built-in)
fnm exec --using 22 pnpm check   # lint, build, typecheck, tests
```

The pre-commit hook runs `pnpm check` and keeps `src/` under 450 lines.
