# Put Scenario execution behind a runtime seam

Auto-QA v1 will execute Accepted Scenarios with directly managed Playwright, while the workflow depends only on a narrow Scenario-runtime interface that accepts a frozen Scenario Attempt and returns its result and Evidence Bundle. The runtime owns automatic final-state visual capture and bounded named checkpoints, including artifact paths, metadata, and finalization; Scenario Scripts request checkpoints without managing evidence storage. The interface will hide browser objects, process lifecycle, and artifact mechanics rather than attempt to abstract every Playwright operation; a deterministic test adapter will exercise the same seam, and existing-browser transports such as Browser Control may be added later without changing the workflow.

`execute` requires an Effect Scope supplied per Attempt by the caller. Runtime
adapters register resource cleanup in that Scope and return finalized evidence
before it closes. The engine bounds active execution inside the Scope, then
awaits cleanup outside that deadline before starting another Scenario or
releasing the Turn. A slow finalizer cannot erase an otherwise completed result.
