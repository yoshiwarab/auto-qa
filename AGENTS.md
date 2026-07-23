# Auto-QA Agent Guidance

Read `CONTEXT.md`, `UBIQUITOUS_LANGUAGE.md`, `docs/system-overview.md`,
`docs/implementation-slices.md`, `docs/testing-strategy.md`, and the relevant
ADRs before changing behavior.

## Toolchain

- Node 22 or newer, with project commands run through FNM using Node 22.
- pnpm is the package manager.
- TypeScript is strict.
- Effect owns services, resources, and typed errors.
- Commander parses CLI arguments only and hands control to Effect immediately.
- Vitest is the test runner. Playwright is invoked as a library by Auto-QA and
  by Vitest-driven integration tests.

## Engineering rules

- Implement one vertical tracer bullet at a time using red/green TDD.
- Test through the public seams agreed in `docs/testing-strategy.md`; do not
  couple tests to private helpers or SQLite table layouts.
- Preserve the host-neutral `WorkflowEngine` boundary.
- Never hardcode a Base URL in prompts, schemas, Scenario Scripts, fixtures, or
  defaults. Tests use harness-supplied ephemeral URLs.
- The Target Application is externally started and externally owned.
- Do not start work from a later implementation slice until its prerequisites
  in `docs/implementation-slices.md` are present.
- Keep automatic work crash-consistent: persist its operation journal entry
  before beginning side effects and checkpoint every transition.

## Verification

As scripts become available, run focused tests frequently, then:

```bash
fnm exec --using 22 pnpm test
fnm exec --using 22 pnpm typecheck
fnm exec --using 22 pnpm lint
```

Run browser, crash, mutation, and acceptance gates only through their dedicated
scripts so the fast suite remains suitable for frequent use.
