# Expire Run evidence under a Retention Policy

Auto-QA will prevent evidence accumulation through configurable Run Retention, surfaced as `runs storage`, `runs expire [--dry-run]`, and `runs keep <run-id>`. Expiration removes evidence only for eligible completed Runs, never active, blocked, or Kept Runs; the separate `cleanup` command remains responsible only for stale runtime resources, avoiding the dangerous ambiguity of pairing `cleanup` with a destructive `runs clean` command.
