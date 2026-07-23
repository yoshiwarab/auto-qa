# Open Questions

## Long-running CLI output

The agent-facing output contract should be prototyped once the walking skeleton can execute a Scenario long enough for progress behavior to matter.

Compare:

1. One final JSON document on stdout with interactive progress on stderr.
2. JSON Lines events on stdout ending in a final result event.
3. Quiet single-document output by default with an explicit progress option.

Evaluate each shape against:

- reliable parsing by different coding agents;
- useful feedback during multi-minute `submit` Turns;
- clean CI logs;
- unambiguous errors and exit codes;
- interruption behavior before a final result exists;
- strict prevention of secrets in either output stream.

The provisional hypothesis is one final JSON document on stdout with optional TTY progress on stderr, but it is not yet a decision.

## Zero-configuration execution budgets

The walking skeleton should measure and tune defaults for:

- maximum Scenarios per plan;
- per-Scenario timeout;
- cumulative active automatic-work wall-time budget;
- any difference between local and CI Mode.

Defaults should let a typical frontend change run without configuration while rejecting obviously unbounded plans and keeping one `submit` Turn within a predictable human-scale duration. The CLI must show the effective limits in plan-validation errors and Run status.
