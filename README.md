# Auto-QA

Auto-QA is an agent-neutral local CLI for verifying frontend changes through a
durable, enforced browser-QA workflow.

The architecture is described in [the system overview](docs/system-overview.md)
and [ADRs](docs/adr/). Implementation proceeds through
[seven vertical slices](docs/implementation-slices.md), backed by the
[testing strategy](docs/testing-strategy.md).

Development uses repository-owned Git hooks and explicit verification commands.
Run `fnm exec --using 22 pnpm check` for the fast gate. See
[repository verification](docs/verification.md) for setup, push checks, and
deeper browser and mutation checks. No SwarmForge session or role handoff is
required.

The current [evidence-review workflow](docs/evidence-review.md) records ordinary
Script failures, captures final screenshots and accessibility snapshots, and
requires agent classification before reporting a Run Outcome. It supports
report-only completion; automatic repair and reruns are not implemented yet.

After a crashed Run, `auto-qa cleanup` reconciles owned browser resources in the
current Git worktree without abandoning the Run or deleting finalized evidence.
It removes owned browser profiles and unpublished evidence staging directories. See
[browser resource recovery](docs/browser-resource-recovery.md) for safety checks
and remaining crash-window limits.
