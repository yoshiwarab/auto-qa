# Plan-details dogfooding, September 22, 2026

## Implementation rerun later that day

The gaps below now have a working report-only path. The same frozen v2 plan ran
against fresh copies of all three changes in `reports/dogfood-plan-details-L3EGiC/`.
All twelve Attempts produced runtime-owned final screenshots and accessibility
snapshots. Each Run stopped at a durable `classify-findings` Job before reporting.

| Change | Mechanical results | Result after submitted review |
| --- | --- | --- |
| White-on-white contents, A | Four passes | `defects-found`, with three visual-defect classifications. |
| Working disclosure, B | Four passes | `passed`, with four `verified-success` classifications. |
| Broken interaction, C | Four assertion failures | `defects-found`, with `coverageIncomplete: true` for later checks not reached. |

The implementing agent inspected all twelve PNGs and accessibility snapshots,
plus the failed-Attempt diagnostics, then submitted its classifications through
the CLI. This was a known-case implementation check, not another blind evaluation
or evidence that any reviewer model will reliably catch these bugs. No
supplemental browser execution supplied evidence for these reviews.

The trial used the packed CLI for browser execution. The current built CLI
submitted the reviews after adding the explicit `coverageComplete` field exposed
by C's partial coverage. Review payloads and CLI responses are retained beside
the execution transcripts as `case-*-review.json` and `case-*-review-result.json`.
Each Run also contains `report.md` and `report.json`.

All three Targets remained alive and reachable after Auto-QA's execution. Each
resource check found an empty runtime directory and no registry. The harness
then stopped the Targets. No seeded changes were made to the normal QA Lab app.

Remaining limits include final-state-only captures, no trace/video/network
bundle, no automated repair or rerun flow, and reviewer judgment that the
runtime records but cannot prove correct. See [the current workflow](../evidence-review.md).

## Initial trial

Auto-QA executed the working change successfully, but this trial does not support
using it as a complete QA replacement yet. An obvious visual defect received a
`passed` Run Outcome. A broken interaction produced a generic runtime error,
without enough evidence for the agent to classify it.

## What ran

A separate QA agent authored four Scenarios from the plan-details requirements:
desktop open/close/reopen, keyboard operation, mobile layout, and existing
content/navigation. It could inspect the original application, not the seeded
changes or case identities. The same frozen plan ran against three isolated,
typechecked and built copies of QA Lab through the actual packed CLI. The apps
were externally owned, with harness-supplied ephemeral Base URLs.

The initial plan passed the runtime's Base URL object directly to `page.goto`.
All three submissions failed with `ScenarioRuntimeError`. The agent needed
runtime source inspection to identify the URL/string mismatch because stdout
did not contain the underlying exception. It corrected only those four calls
and reran against fresh repositories. Both versions are retained.

## Corrected-plan results

| Change | Auto-QA result | What the result supports |
| --- | --- | --- |
| Working disclosure, case B | Four mechanically passing Attempts; completed/passed | Expected control result, but no visual verification. |
| Broken disclosure interaction, case C | First Scenario returned `ScenarioRuntimeError`; remaining Scenarios did not execute | Failure detected, but no useful assertion diagnostic or completed defect report. |
| White-on-white disclosure contents, case A | Four mechanically passing Attempts; completed/passed | False pass against the readability requirement. |

For A and B, every manifest listed only `result.json`. There were no screenshots
or accessibility snapshots, and neither Run offered a success-classification
Job before completion. The blind reviewer declined to call either result
`verified-success` from that evidence alone.

For C, the first failed command left the Run in `executingScenarios`, with no
pending Job. Explicitly repeating the identical submission recovered an
`interrupted` Finding for `plan-details-desktop`, with `evidenceBundle: null`.
Its summary said execution was interrupted before a durable result. That lost
the distinction between an ordinary assertion failure and an actual crash.
The repeat's exit code 0 meant workflow recovery succeeded, not that QA passed.

## Supplemental observations

After the reviewer recorded its Auto-QA-only assessment, the frozen scripts ran
again in separately scoped Playwright sessions. These sessions are explicitly
outside Auto-QA and are not credited to its evidence pipeline.

The independent re-execution reproduced four mechanical passes each for A and B,
and four failed Scenarios for C. The desktop and mobile screenshots for A showed
an expanded but blank-looking plan panel. Its accessibility snapshot still
contained the heading and all three values. This illustrates why DOM visibility
and accessibility text alone did not establish readability. B's screenshots
showed the same content legibly. C failed while waiting for the `Plan details`
heading after attempting to open the disclosure.

Still without seeing the seed map, the reviewer classified A as an application
defect, B as verified success within the tested scope, and C as an application
defect with later checks incomplete. It inspected desktop/mobile screenshots
and keyboard focus evidence. These were external assessments, not classifications
submitted to or enforced by Auto-QA.

## Dogfooding blockers exposed

1. Preserve ordinary assertion/script failures as failed Attempts with useful,
   bounded diagnostics. Continue the batch where appropriate instead of leaving
   an unfinished execution that later becomes `interrupted`.
2. Capture runtime-owned screenshots and accessibility snapshots for passing
   and failing Attempts. The agent needs the rendered result, not only a pass
   flag. Desktop/mobile checkpoints must show the state being assessed.
3. Implement the specified classification step for mechanically passing
   Attempts before a Run can report success. This trial's reviewer withheld
   visual approval, but the runtime had already completed the Run.
4. Make the Scenario contract discoverable in the Job, including the Base URL
   type and navigation example. A generic runtime error is not enough to repair
   an otherwise reasonable agent-authored plan.

These are observed usability gaps, not claims that every planned Slice 4 feature
must ship before any dogfooding is useful. No runtime fixes were bundled into
this trial, and no seeded bug was added to QA Lab's normal source.

## Resource checks and retained evidence

Both trial rounds recorded that each Target Application remained running and
reachable after Auto-QA finished, its runtime directory was empty, and its
registry was gone. The harness then stopped each Target Application. A process
check after supplemental observation found no surviving trial browsers,
launchers, or Vite preview servers.

- [Experiment and replay instructions](../../experiments/plan-details/README.md)
- [Original plan](../../experiments/plan-details/plan.json)
- [Corrected plan](../../experiments/plan-details/plan-v2.json)
- Original trial output: `reports/dogfood-plan-details-l2rfkk/`
- Corrected trial output: `reports/dogfood-plan-details-OOyVEU/`
- [Case A CLI transcript](../../reports/dogfood-plan-details-OOyVEU/case-a.json)
- [Case B CLI transcript](../../reports/dogfood-plan-details-OOyVEU/case-b.json)
- [Case C CLI transcript](../../reports/dogfood-plan-details-OOyVEU/case-c.json)
- [A desktop supplemental screenshot](../../reports/dogfood-plan-details-OOyVEU/supplemental/case-a/plan-details-desktop/page.png)
- [B desktop supplemental screenshot](../../reports/dogfood-plan-details-OOyVEU/supplemental/case-b/plan-details-desktop/page.png)
- [C supplemental exception](../../reports/dogfood-plan-details-OOyVEU/supplemental/case-c/plan-details-desktop/result.json)

Raw output lives in gitignored `reports/`; replay creates new output directories.
The plans, fixture generator, diagnostic script, and this report are source files.
This was one exploratory trial, not a blinded statistical benchmark, a comparison
against an unstructured agent, or a measured improvement in QA quality.
