# auto-qa agent guidance

Read `README.md` first. auto-qa is deliberately small. The finished tool
(`run`, `cleanup` and a later `triage`) has a budget of about 450 lines of
`src/`.

- Prefer Playwright's own config, CLI flags, reporters and fixtures over custom
  plumbing. Delete before adding; a new abstraction needs more than one use.
- Plain TypeScript and Node built-ins. No runtime dependencies.
- Never hardcode a Base URL. Tests use the ephemeral server in
  `test/auto-qa.test.ts`.
- The target application is started and owned by someone else; auto-qa never
  starts or stops it.
- Cleanup kills only processes carrying an auto-qa marker, never by name, and
  never deletes `.auto-qa/runs` evidence.

Verify with `fnm exec --using 22 pnpm check`, which runs lint, build,
typecheck, and the browser tests.
