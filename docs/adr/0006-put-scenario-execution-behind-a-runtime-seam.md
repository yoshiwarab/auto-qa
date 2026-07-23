# Put Scenario execution behind a runtime seam

Auto-QA v1 will execute Accepted Scenarios with directly managed Playwright, while the workflow depends only on a narrow Scenario-runtime interface that accepts a frozen Scenario Attempt and returns its result and Evidence Bundle. The interface will hide browser objects, process lifecycle, and artifact mechanics rather than attempt to abstract every Playwright operation; a deterministic test adapter will exercise the same seam, and existing-browser transports such as Browser Control may be added later without changing the workflow.
