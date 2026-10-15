# Ubiquitous Language

## Workflow lifecycle

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Run** | A durable Auto-QA workflow for one set of frontend changes and one Target Application. | Session, test run |
| **Turn** | One exclusive interaction that begins with an external Event and continues through automatic work until an Input Boundary or terminal phase. | Command, request |
| **Job** | A structured request for the coding agent to supply the next external input required by a Run. | Prompt, task |
| **Input Boundary** | A point where a Turn stops because external input or action is required. | Pause, wait state |
| **Run Outcome** | The final QA conclusion `passed`, `defects-found`, or `inconclusive`, separate from workflow lifecycle. | Status, phase |

## Browser verification

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Scenario** | A stable verification identity describing the behavior to prove, its goal, preconditions, and mutation declaration. | Test, spec, script |
| **Scenario Script** | One numbered, immutable, accepted Playwright implementation of a Scenario. | Scenario Revision, Scenario Instance, Scenario Implementation |
| **Script Version** | The zero-based ordinal of a Scenario Script; version 0 is the initial accepted Script and later accepted corrections increment it. | Revision number, attempt number |
| **Attempt** | One execution of exactly one Scenario Script. | Retry, Scenario Instance, execution |
| **Finding** | A reviewable result raised from every Attempt and awaiting coding-agent classification. A mechanically passing Attempt produces a success Finding. | Error, failure |
| **Verified Success** | The classification applied when a mechanically passing Attempt's assertions and visual evidence together support its Scenario goal. | Playwright pass, automatic success |
| **Evidence Bundle** | The human-readable and machine-readable artifacts produced by one Attempt. | Output, logs |

## Relationships

- A **Run** contains one or more **Scenarios**.
- A **Scenario** owns one or more numbered **Scenario Scripts**.
- An **Attempt** references exactly one **Scenario Script** by Scenario identity and Script Version.
- Every **Attempt** produces exactly one **Finding** for the next atomic classification batch.
- A mechanically passing **Attempt** is not a **Verified Success** until the coding agent has inspected its visual evidence and classified its success Finding.
- A **Finding** remains in Run history even when a later Script Version passes.
- A **Run Outcome** reflects the latest required Attempts and unresolved dispositions, not the absence of historical Findings.

## Example dialogue

> **Dev:** “Did the draft-roundtrip Scenario change?”
>
> **Domain expert:** “Its goal did not. The agent revised its Scenario Script, producing Script Version 1.”
>
> **Dev:** “So what did the rerun execute?”
>
> **Domain expert:** “Attempt 2 ran Script Version 1. Attempt 1 still points to Script Version 0 and keeps its original evidence.”

## Flagged ambiguities

- **Scenario Revision** made “Revision 0” surprising and blurred stable Scenario intent with replaceable Playwright source. **Scenario Script** is now the canonical entity and **Script Version** its ordinal; “revise the Scenario Script” remains a useful verb phrase.
- **Scenario** is stable intent and identity; frozen Playwright source belongs exclusively to **Scenario Script**.
- **Scenario Instance** or **Instantiation** collides conceptually with **Attempt**, which is the actual runtime instance of executing a Script.
- A `passed` **Attempt** describes its mechanical Playwright result, not a **Verified Success**. Finding classification adds agent judgment but cannot turn a mechanically nonpassing Attempt into a success.
