# Block unexpected source drift

Each Run records a Git worktree fingerprint at start and verifies it before agent actions and Scenario execution. Unexpected changes block a report-only Run and require fresh planning, while an `agent-fix` Run permits changes only during a pending `fix-application` Job, then records the new fingerprint and reruns affected Scenarios; reports identify both initial and final Git state.
