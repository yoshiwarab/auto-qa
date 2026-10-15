# Bound plan size and execution time

Auto-QA validates plans against configurable limits for Scenario count, per-Scenario timeout, and cumulative active automatic-work wall time before browser work begins. The cumulative clock spans Turns and includes both browser and non-browser automatic work, but excludes time waiting at an Input Boundary and mandatory recovery or cleanup. Exhausting the budget stops new ordinary work while still allowing scoped cleanup and makes skipped coverage explicit in the report. Exact zero-configuration limits will be tuned against the walking skeleton rather than fixed by architecture alone.

Terminal reporting has a separate 30-second allowance per invocation, including
recovery after a failed report write. It does not require or consume remaining
ordinary-work budget. The accepted review and reporting journal entry remain
durable if that allowance expires, so the identical submission can retry without
executing Scenarios. This lets an exhausted Run report incomplete coverage and
release the worktree instead of becoming permanently stuck in `reporting`.
