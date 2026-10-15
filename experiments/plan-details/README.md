# Plan-details dogfooding trial

This is an exploratory trial of an external agent using Auto-QA, not a model
benchmark or a deterministic acceptance gate. No production runtime code or
normal QA Lab source is modified by this experiment.

## Requirements given to the QA agent

The Account subscription card gains a native expandable details section with
the accessible summary `View plan details`. It starts collapsed. Opening it
reveals the `Plan details` heading and these values:

- Billing cycle: Monthly
- Price: $48 per month
- Included seats: 20

Users can close and reopen it with the mouse or keyboard. Content must remain
readable on desktop and mobile. Existing Account content and navigation must
continue to work. The interaction does not write server state.

The QA agent could inspect the original QA Lab source but not the trial runner,
case patches, or changed application source. It authored four Scenarios before
seeing case results. It requested screenshots and accessibility snapshots for
visual judgment, without inventing a runtime evidence API.

`plan.json` preserves its first plan. `plan-v2.json` changes only the four
`page.goto(baseUrl)` calls to `page.goto(baseUrl.toString())`. The runtime passes
a URL object; Playwright navigation requires a string. This correction was made
after the first trial, without revealing case identities or weakening assertions.

## Replay

Run from the repository root with dependencies and Playwright browsers already
installed, as for the dedicated browser gate:

```bash
fnm exec --using 22 pnpm build
fnm exec --using 22 node experiments/plan-details/trial.mjs experiments/plan-details/plan-v2.json
```

The runner prints its output directory under `reports/dogfood-plan-details-*`.
It packs the current CLI, creates separate Git repositories from the current
QA Lab baseline, applies actual source changes, typechecks and builds each app,
and externally starts each app on an ephemeral loopback address. Node and app
dependencies are reused locally; this is not a clean-install packaging test.

Each case executes `start`, `job`, `submit`, `status`, `job`, and `cleanup`.
After a failed submission it explicitly repeats the same submission and observes
recovery, without changing the plan. JSON transcripts retain commands, stdout,
stderr, exit codes, and durations. Each output includes the exact plan and its
SHA-256 hash, application patches, finalized evidence, and resource observations.
The harness stops its Target Application when each case ends. Runtime state and
reports remain on disk for inspection. Nothing is exposed through Tailscale.

Only after assessing Auto-QA's own results, obtain supplemental browser evidence:

```bash
fnm exec --using 22 node experiments/plan-details/diagnostics.mjs <printed-output-directory>
```

This independently executes the frozen trusted scripts using Playwright and
saves screenshots, accessibility snapshots, and exceptions under `supplemental/`.
It does not run through Auto-QA, does not update its Runs, and must not be counted
as evidence Auto-QA produced. Its eight-second action timeout bounds diagnostics;
the normal assertion timeout remains five seconds.

## Case identities

Do not show this section or `trial.mjs` to an evaluator before assessment.

| Case | Source change |
| --- | --- |
| A | Functional disclosure, but its contents are white text on white background. |
| B | Working disclosure with readable content. |
| C | Summary click handler prevents the native disclosure from opening. |

The clean control and seeded defects are intentionally simple. One agent and one
corrected run per case can expose workflow gaps but cannot estimate detection
rates or establish that Auto-QA improves model QA quality.

See [the recorded findings](../../docs/dogfooding/plan-details-2026-09-22.md).
