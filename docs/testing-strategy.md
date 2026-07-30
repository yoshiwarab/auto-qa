# Auto-QA V1 Testing Strategy

Auto-QA coordinates code supplied by an agent, a real browser, durable state,
and operating-system resources. Its test suite must prove not only that the
happy path works, but that interruption, repetition, malformed input, and
partial failure cannot violate the workflow contract or leave resources behind.

## Behavioral seams

Tests observe behavior through these stable seams:

1. **Workflow Engine** — `dispatch`, `getPendingJob`, and `getStatus`.
2. **CLI process protocol** — commands, versioned JSON stdout, stderr, and exit
   codes from the packaged executable.
3. **Scenario Runtime contract** — the same Attempt contract exercised against
   the deterministic test adapter and directly managed Playwright adapter.
4. **Project configuration and authentication contracts** — trusted project
   hooks, Auth Profile preparation, Auth Setup, and verification.
5. **Artifact contracts** — documented Evidence Bundle, Review Bundle, report,
   manifest, and machine-status formats.

SQLite tables, private helpers, internal call order, and Playwright method call
counts are not test seams. Persistence is normally exercised through the
Workflow Engine or a restarted CLI process. A narrow adapter contract test may
inspect an adapter only through its domain interface.

## Test layers

### Machine model

- Generate every Phase × Event case from `TRANSITIONS`: listed entries land in
  the declared Phase and unlisted entries return `InvalidTransition` with the
  allowed Events.
- Prove every Phase is reachable from `idle` and every nonterminal Phase has a
  path to a terminal Phase.
- Generate coverage requiring every automatic Phase to declare work and a
  recovery policy, and every Input Boundary to expose a Job or blocking action.
- Check invariants after generated Event sequences, including validated-plan
  requirements, Scenario/Script/Attempt references, single Job completion, and
  immutable completed Runs.
- Generate `docs/machine.md` from the same table and fail CI on drift.

### Workflow and persistence integration

- Exercise complete Turns against a real temporary SQLite database with
  deterministic adapters for Git, browser execution, time, and process
  launching.
- Restart the engine between every externally visible step to prove durable
  handoff.
- Cover identical and conflicting repeated Job submissions, out-of-order Jobs,
  competing mutations, concurrent read-only queries, abandonment, source
  drift, budget exhaustion, and every Run Outcome precedence combination.
- Run the same Run Store contract against each production Store adapter that is
  ever added.

### CLI black-box tests

- Spawn the built or packed CLI in a fresh temporary Git worktree and assert
  only its documented JSON, errors, exit codes, files, and subsequent command
  behavior.
- Cover every command and option, schema version, malformed payload class, and
  typed error mapping.
- Use an ephemeral Base URL supplied by the harness; no test prompt, Scenario
  Script, or fixture assumes a fixed host or port.
- Include clean-install and `pnpm pack` smoke tests so source-only imports
  cannot hide packaging failures.

### Real-browser end-to-end tests

- Start the QA Lab Target Application from `apps/qa-lab` externally and execute
  the packaged CLI with real Chromium.
- Cover passing, assertion failure, timeout, console error, request failure,
  screenshot, trace, video mode, Mutating Scenario permission, batch
  continuation, and report generation.
- Assert that each Attempt uses an isolated context, its frozen Scenario Script
  bytes, its deterministic evidence path, and no browser or child process
  survives the invoking process.
- Keep a small deterministic browser suite on ordinary CI; run broader repeated
  stress cases separately so flake detection does not slow every edit.

### QA Lab

- The product shape and test contract are defined in
  [qa-lab.md](./qa-lab.md).
- `apps/qa-lab` is a private, independently runnable pnpm workspace package used
  only as a Target Application for browser and acceptance tests. It is not a
  runtime dependency of Auto-QA and is not part of the packed CLI.
- Add deterministic, accessible UI states to QA Lab only when a browser
  Scenario needs them. The first state serves an accessible `Account` heading
  for the existing passing-Scenario acceptance path.
- The test harness starts QA Lab in a separate process using a harness-selected
  ephemeral address, waits for readiness, supplies the resulting Base URL to
  Auto-QA, and stops QA Lab after the test.
- Auto-QA neither imports QA Lab nor starts, configures, or stops its process.
  Browser tests must continue to prove that QA Lab remains running after the
  Auto-QA process completes.

### Crash and recovery tests

- Inject termination immediately before and after every durable checkpoint in a
  scripted Run.
- On the next invocation, assert the declared per-Phase recovery policy, no
  duplicate Scenario side effects, and correct handling of temporary evidence.
- SIGKILL the CLI during browser launch, execution, evidence finalization, Auth
  Setup, and reporting; then run reconciliation and prove that registered
  resources and stale locks are cleared without killing unrelated processes.
- Simulate stale locks, PID reuse, mismatched ownership tokens, truncated
  registry writes, SQLite busy errors, and atomic-promotion failures.
- Repeat recovery tests enough times to reveal ordering and cleanup flakiness.

### Authentication and secret safety

- Exercise local Auth Profile capture/verification and application-owned Auth
  Setup as separate contracts.
- Cover missing, expired, wrong-origin, verifier-failed, interrupted, and
  explicitly retried authentication.
- Seed unique secret canaries and scan stdout, stderr, Jobs, status artifacts,
  reports, manifests, screenshots metadata, console/network/action logs, and
  SQLite diagnostic exports for disclosure.
- Prove interrupted Auth Setup never resumes or retries without an explicit
  external decision.

### Evidence, reporting, and retention

- Validate every finalized bundle against a versioned manifest/schema.
- Prove temporary Attempt directories are not linked or published and are
  promoted only after required artifacts and `result.json` are durable.
- Cover `passed`, `defects-found`, `inconclusive`, and
  `defects-found + coverageIncomplete` reports with fixed worked examples.
- Prove retention never removes active, blocked, or Kept Runs and never treats
  runtime cleanup as evidence expiration.

## Failure matrices

The suite maintains explicit tables for:

- every Finding classification combination and reliability-first route;
- every recovery policy and interruption point;
- every Job type with valid, invalid, stale, repeated-identical, and
  repeated-conflicting submission;
- every CLI command with success, usage error, domain rejection, busy Run, and
  unrecoverable tool failure;
- report-only versus agent-fix behavior;
- anonymous, local-profile, and unattended authentication;
- local versus CI evidence and exit-code policy.

These matrices are specifications. Generated tests consume them where possible
so adding a new enum member without a case fails immediately.

## Isolation and determinism

- Every test owns a fresh temporary directory, Git worktree, `.auto-qa` home,
  SQLite database, registry, and ephemeral port.
- Time, ids, randomness, process identity, and crash points are injectable at
  their boundary interfaces. Expected values remain independent worked
  examples rather than recomputations of production logic.
- Tests never kill by process name and never share a target directory or fixed
  Base URL.
- Process-based tests perform a final invariant check for surviving registered
  resources, lockfiles, and publishable temporary evidence, including after
  test failure.

## CI tiers

1. **Fast gate:** type checking, formatting/linting, machine-model tests,
   workflow integration, and deterministic contract tests.
2. **Browser gate:** packaged CLI against real Chromium, artifact validation,
   and representative crash recovery.
3. **Deep gate:** full checkpoint kill matrix, repeated SIGKILL/resource-leak
   tests, selected mutation testing of guards/recovery/outcome logic, and
   bounded stress runs.
4. **Release gate:** clean Node 22 installation, packed executable smoke test,
   migration compatibility fixtures, and all versioned wire/artifact schemas.

The repository will decide whether the browser gate runs on every pull request
or on a dedicated workflow based on measured duration. The fast gate remains
required on every change.

## Test quality gates

Line coverage is diagnostic, not the primary definition of completeness. The
hard behavioral gates are:

- 100% Phase × Event transition-table coverage;
- every automatic Phase has tested success, typed failure, and interruption
  behavior appropriate to its recovery policy;
- every Job and CLI error maps to its documented machine-readable response and
  exit code;
- every owned-process test ends with no leaked registered resources;
- mutation testing of the pure transition guards, recovery routing, and Outcome
  precedence reaches an agreed threshold before v1 release;
- no checked-in machine diagram or versioned schema drift.

Numerical line, branch, mutation, and duration thresholds should be set from the
walking skeleton's baseline. They must catch regressions without incentivizing
tests of private implementation details.
