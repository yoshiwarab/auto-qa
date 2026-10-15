# Fence Turn and resource ownership

Auto-QA v1 will use an atomically acquired worktree-scoped Turn lock whose metadata includes the owning Run, process identity, process start time, and a unique ownership token. Stale takeover verifies identity and reconciles only registry-owned resources; Auto-QA never kills by process name or PID alone. Before the first Playwright launch, a durable registry entry records a unique launch token and resource identity, and normal release is idempotent. Slice 2 implements registration and normal cleanup; Slice 3 adds stale-owner reconciliation and SIGKILL coverage. These mechanisms protect Auto-QA-owned local resources but do not serialize independent worktrees or claim isolation inside an externally owned Target Application.

The current Linux implementation and its remaining crash-window limitations
are documented in [browser resource recovery](../browser-resource-recovery.md).
The Scenario Runtime owns reconciliation; the host-neutral Workflow Engine
invokes it only after acquiring the worktree Turn, outside active-work budgets.
