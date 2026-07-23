# Test through public behavioral seams

Auto-QA will be developed test-first through a small set of stable behavioral
seams: the host-neutral `WorkflowEngine`, the versioned CLI process protocol,
the `ScenarioRuntime` adapter contract, the project configuration and
authentication contracts, and the documented Evidence/Review Bundle formats.
Most workflow tests use real temporary SQLite stores with deterministic
boundary adapters; browser end-to-end tests use the packaged CLI, an externally
owned fixture Target Application, and real Chromium. Tests may inject
time, randomness, process launching, and crash points at system boundaries, but
will not mock Auto-QA's own internal modules or inspect private database tables
as their assertion surface. Generated machine coverage, semantic invariants,
fault injection, secret canaries, and resource-leak checks supplement
example-based tests. Each implementation slice lands through red/green tracer
bullets rather than building the entire suite or subsystem horizontally.
