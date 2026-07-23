# Auto-QA V1 Implementation Slices

Each slice lands as a usable vertical increment with its tests passing. Infrastructure is introduced only when the first behavior needs it, but crash-safety invariants are not deferred past the first corresponding side effect.

Implementation follows test-driven tracer bullets through the agreed public
seams. Every behavior begins with one failing behavioral test, adds only enough
implementation to pass, and then expands to the next case. The complete test
architecture is defined in [testing-strategy.md](./testing-strategy.md).

## Slice 1: Protocol and durable handoff

Deliver:

- Node 22+, pnpm, strict TypeScript, Effect, Commander, and Vitest project setup;
- runtime-neutral `WorkflowEngine` with `dispatch`, `getPendingJob`, and `getStatus`;
- plain transition table, pure guards and `step`, and the first automatic phase work;
- versioned CLI/Job envelope, typed errors, correlation ids, and exit-code mapping;
- SQLite Run Store, operation journal, and atomically acquired fenced Turn lock;
- Git Change Inspector;
- `start`, read-only `job` and `status`, one-active-Run enforcement, and `runs abandon`;
- generated transition-table coverage and CLI process tests for the acceptance
  path, invalid transitions, exit codes, and restart durability.

Acceptance path:

```text
start -> inspect Git -> persist generate-plan Job -> new process reads job/status
```

## Slice 2: Crash-safe happy-path Playwright

Deliver:

- idempotent `submit` with completed Job payload hashes;
- atomic plan validation and Scenario Script Version 0;
- directly managed Playwright behind `ScenarioRuntime`;
- Effect-scoped browser, context, and child-process ownership;
- durable resource-registry entry before owned browser work proceeds;
- externally started fixture Target Application owned by the test harness;
- one passing Attempt;
- temporary Evidence Bundle staging, `result.json` and manifest finalization, and atomic promotion;
- minimal report and `completed` / `passed`;
- cumulative active automatic-work budget accounting, with numerical defaults
  still provisional;
- real Chromium end-to-end coverage plus resource-leak and secret-canary
  assertions on the happy path.

## Slice 3: Crash and recovery hardening

Deliver:

- complete per-phase recovery matrix;
- stale lock and registered-resource reconciliation;
- PID-recycling and ownership-token checks;
- kill-between-checkpoint tests;
- SIGKILL cleanup coverage;
- generated transition tests, semantic invariants, and machine Mermaid generation;
- reconciliation of crash-interrupted Attempts and temporary evidence;
- fault injection at every durable checkpoint and repeated cleanup/recovery
  tests that assert no duplicate side effects.

## Slice 4: Failure and reliability loop

Deliver:

- continue-after-failure Scenario batches;
- full screenshots, trace, video, console, network, and action evidence;
- atomic `classify-findings`;
- reliability-first routing;
- `revise-scenario-script` with Versions 1 and 2;
- `confirm-rerun` and `rerun --failed`;
- bounded retries, replacement Scripts, and explicit inconclusive coverage;
- generative Event-sequence tests and complete classification/routing outcome
  matrices.

## Slice 5: Authentication

Deliver:

- local Auth Profile capture, verification, listing, and exact-origin binding;
- application-owned unattended Auth Setup and project verifier;
- anonymous versus Run-authenticated Scenario contexts;
- `blocked -> explicit fresh retry or abandon` after interrupted Auth Setup;
- secret-safe evidence and reporting boundaries;
- Auth Profile, Auth Setup, verifier, interruption, and secret-redaction
  contract tests.

## Slice 6: Application remediation and source drift

Deliver:

- report-only and agent-fix Remediation Policies;
- `fix-application`;
- authorized source-fingerprint changes;
- rerun of defect Scenarios and agent-declared affected coverage;
- historical-defect resolution with a final `passed` Outcome when all latest required Attempts pass;
- report-only/agent-fix, source-drift, affected-coverage, and final-Outcome
  integration matrices.

## Slice 7: Retention, Review Bundle, and CI packaging

Deliver:

- immutable completed workflow facts with mutable retention metadata;
- `runs storage`, `runs expire`, and `runs keep`;
- polished report and provider-neutral Review Bundle;
- versioned machine status artifact and CI exit-code mapping;
- GitHub Actions publication recipe;
- measured defaults for execution limits and the final long-running progress contract;
- packed-CLI installation smoke tests, Review Bundle schema tests, retention
  safety tests, and bounded stress/mutation suites.

## Adopted product decisions

1. The Run budget counts cumulative active automatic-work wall time across
   Turns, excluding Input Boundary waiting and mandatory recovery or cleanup.
2. Interrupted Auth Setup blocks until an explicit fresh attempt or Run
   abandonment; it is never resumed or silently retried.
3. Independent worktrees may target the same application environment in v1.
   Auto-QA documents but does not claim to prevent shared-state interference.
4. An unresolved Confirmed Defect remains `defects-found` even when coverage is
   incomplete; the result also sets `coverageIncomplete: true` and names the
   incomplete Scenarios.
