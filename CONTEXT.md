# Auto-QA

Auto-QA coordinates agent-directed browser verification of frontend changes through a durable, enforced workflow.

## Language

**Run**:
A durable instance of the Auto-QA workflow for one set of frontend changes and one target application.
_Avoid_: Session, test run

**Run Outcome**:
The final QA conclusion of a completed Run: `passed`, `defects-found`, or `inconclusive`. It is distinct from the Run's workflow phase.
_Avoid_: Status, phase

**Target Application**:
The externally started and externally owned web application that a Run verifies at its supplied Base URL.
_Avoid_: Fixture app, dev server

**Base URL**:
The Run-specific address of the Target Application, supplied when the Run starts and injected into Scenario execution rather than embedded in prompts or scripts.
_Avoid_: App URL, default URL

**Auth Profile**:
Reusable local authentication state captured for one Target Application without retaining the human's credentials.
_Avoid_: Login, browser profile

**Auth Setup**:
Application-owned trusted code that prepares fresh authentication state for an unattended Run using credentials or test facilities supplied by the Run environment.
_Avoid_: Fake auth, login script

**Turn**:
One exclusive interaction with a Run, beginning with an external event and continuing through automatic work until the Run reaches an input boundary or terminal phase.
_Avoid_: Command, request

**Job**:
A structured request for an external coding agent to provide the next input required by a Run.
_Avoid_: Prompt, task

**Input Boundary**:
A point where a Turn stops because the Run requires an external coding agent response or another explicit external action before automatic work can continue.
_Avoid_: Pause, wait state

**Scenario**:
A stable browser-verification identity describing the behavior to prove, its goal, preconditions, and mutation declaration.
_Avoid_: Test, spec, script

**Mutating Scenario**:
A Scenario declared to change Target Application state through browser interaction and permitted only by an explicitly mutation-enabled Run.
_Avoid_: Destructive test, write test

**Accepted Scenario**:
A Scenario whose payload and initial Scenario Script have passed atomic plan validation.
_Avoid_: Safe scenario, compiled test

**Scenario Script**:
One numbered, immutable, accepted Playwright implementation of a Scenario; version zero is the initial Script and accepted test-issue corrections create later versions.
_Avoid_: Scenario Revision, Scenario Instance, Scenario Implementation

**Script Version**:
The zero-based ordinal identifying one Scenario Script within its Scenario.
_Avoid_: Revision number, attempt number

**Attempt**:
One execution of exactly one Scenario Script, identified by Scenario, Script Version, and monotonically increasing attempt number.
_Avoid_: Retry, execution

**Finding**:
A reviewable result raised from every Scenario Attempt and awaiting coding-agent classification. A mechanically passing Attempt produces a success Finding that the agent must verify against its evidence rather than accepting automatically.
_Avoid_: Error, failure

**Verified Success**:
The classification applied when a mechanically passing Attempt's assertions and visual evidence together support its Scenario goal.
_Avoid_: Playwright pass, automatic success

**Confirmed Defect**:
A Finding that the coding agent has classified as an `app-defect`; only a Confirmed Defect may authorize application remediation.
_Avoid_: Failure, likely defect

**Remediation Policy**:
The immutable Run-level choice between reporting application defects and asking the coding agent to repair confirmed defects before affected Scenarios are rerun.
_Avoid_: Autofix, fix mode

**Evidence Bundle**:
The human-readable and machine-readable artifacts produced by one Scenario Attempt.
_Avoid_: Output, logs

**Review Bundle**:
A curated, share-ready Run report containing selected screenshots, recordings, and a publication manifest without Auth Profiles or raw forensic evidence.
_Avoid_: Evidence Bundle, PR comment

**CI Mode**:
An agent-driven Run configured for a noninteractive environment, headless browser execution, CI evidence defaults, and machine-significant exit status.
_Avoid_: Autonomous mode, CI integration

**Run Retention**:
The configurable policy that determines when evidence for completed Runs becomes eligible for expiration.
_Avoid_: Pruning, cleanup, garbage collection

**Kept Run**:
A completed Run explicitly exempted from Run Retention.
_Avoid_: Pinned run, permanent run

**Expired Run**:
A completed Run whose evidence was removed after it became eligible under Run Retention.
_Avoid_: Deleted run, pruned run
