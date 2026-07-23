# Mission: Build Auto-QA V1

## Why

Give any coding agent a local, durable, crash-consistent way to verify frontend
changes in a real browser without depending on a particular agent host.

## Success looks like

- The CLI enforces a Job-driven workflow through a host-neutral Workflow Engine.
- SQLite checkpoints every transition and operation boundary.
- Playwright runs frozen Scenario Scripts in scoped, isolated browser contexts.
- Failed and interrupted Attempts produce portable evidence and honest Outcomes.
- Local and CI authentication paths remain explicit and secret-safe.
- Cleanup never kills unowned resources and completed evidence remains
  reviewable under a bounded retention policy.
- Extensive behavioral, browser, recovery, and security tests protect every
  implementation slice.

## Delivery

Implement the vertical slices in `docs/implementation-slices.md` in order using
the four-role SwarmForge flow documented in `docs/swarm-forge.md`.
