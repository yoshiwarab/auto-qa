# Use SQLite for authoritative workflow state

Auto-QA will store Runs, transitions, Jobs, submission hashes, operation journals, Scenarios, Attempts, and Findings in `.auto-qa/state.db` using short SQLite transactions. This replaces the proposed atomic `state.json` because a Turn must commit several related facts consistently during checkpointing and recovery; evidence bundles, auth profiles, and the emergency cleanup registry remain files, and a per-Run lockfile still owns the full Turn without holding a database transaction open during browser work.
