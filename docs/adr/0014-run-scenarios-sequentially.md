# Run Scenarios sequentially

Auto-QA v1 will execute Scenarios one at a time in deterministic plan order. Separate browser contexts isolate client state but not shared application data, so concurrency could create cross-Scenario interference and would complicate evidence ordering, interruption recovery, and selective reruns; parallelism may be reconsidered only with an explicit application-state isolation model.
