# Repository verification

Auto-QA uses Git hooks and named checks for ordinary development. One coding
agent can implement and verify a change without a SwarmForge session, role
handoffs, or a mandatory model review. Keep the existing test-first vertical
slices and public behavioral seams.

## Setup and Git hooks

```bash
fnm exec --using 22 pnpm install
```

The prepare script retains the existing Effect checkout setup and installs
Husky hooks. Hooks invoke FNM explicitly so they use Node 22 even when Git is
launched from another shell. Git must be able to find FNM and pnpm on `PATH`.

- Pre-commit formats only staged files with Prettier, then runs `pnpm check`.
- Pre-push runs `pnpm verify:push`.

Formatting does not sweep the repository. The generated lockfile and runtime,
vendored, and build directories are excluded. lint-staged preserves unstaged
edits to partially staged files while formatting their staged content. The
subsequent checks inspect the working tree, not an isolated staged snapshot.

These are local Git hooks, not server-side enforcement. They do not start
background agents or watch processes. Checks stop on the first failed command.

## Ordinary commands

Run project commands through `fnm exec --using 22`:

| Command            | Checks                                                   |
| ------------------ | -------------------------------------------------------- |
| `pnpm check`       | ESLint, root and QA Lab type checking, fast Vitest suite |
| `pnpm verify:push` | Fast gate, generated Gherkin acceptance suite, CLI build |

The acceptance gate requires Babashka and the repository's APS checkout. Run
`fnm exec --using 22 pnpm acceptance:setup` once if it is missing. A missing
prerequisite fails the push check; it does not silently skip acceptance.

## Contextual checks

Choose the checks that cover the changed behavior and report their results:

- `pnpm browser` for Scenario Runtime, browser ownership, QA Lab, evidence,
  or packaged-CLI browser behavior. This uses real Chromium through the
  existing Vitest harness, not Expect.
- `pnpm acceptance:mutation` for acceptance features, bindings, generation,
  or runtime semantics.
- `pnpm mutation:workflow-machine`, `pnpm mutation:plan-validation`, or
  `pnpm mutation:cli-protocol` when the corresponding module or its tests change.
- `pnpm test:coverage` and `pnpm analyze:duplication` for coverage gaps and
  structural changes. Treat these as diagnostic evidence, not proof of correctness.

Browser and mutation checks stay out of Git hooks to keep routine commits and
pushes bounded. Use the dedicated scripts; do not fold those suites into the
fast Vitest configuration. Broader crash and cleanup coverage remains product
work in Slice 3, not something these hooks claim to provide.

Executive supplied the pattern for commit and push gates. Its role wrappers,
receipt system, and complexity baseline were not copied. Auto-QA has no agreed
complexity threshold yet; adding one requires a measured baseline and a
deliberate no-regression policy.

## Legacy SwarmForge

The old launchers and configuration remain for existing sessions and to preserve
in-progress edits. They are optional and are not called by hooks or checks.
See [the legacy operator guide](swarm-forge.md) for inspecting and stopping an
existing session. This change does not stop processes or remove worktrees.
