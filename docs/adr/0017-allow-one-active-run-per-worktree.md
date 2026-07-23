# Allow one active Run per Git worktree

Auto-QA v1 permits only one nonterminal Run in a Git worktree; `start` rejects and identifies an existing active or blocked Run, while terminal Runs remain addressable for reports and retention. `runs abandon <run-id>` terminally releases a nonterminal Run with an auditable reason so a blocked Run cannot occupy the worktree forever. The workflow and SQLite records remain keyed by `runId` so separate worktrees operate independently and a future host can add safe concurrency without changing the domain interface.
