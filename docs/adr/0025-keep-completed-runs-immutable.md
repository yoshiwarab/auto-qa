# Keep completed Runs immutable

Once reporting completes, a Run and its Outcome are immutable and cannot be reopened by `rerun --failed`. Retryable Findings, replacement Scenario Scripts, and application remediation may produce new Attempts only before reporting; verification requested afterward creates a new Run with fresh Git context, even if a future convenience command links it to the prior Run as a successor.
