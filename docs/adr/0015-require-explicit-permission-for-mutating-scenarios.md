# Require explicit permission for mutating Scenarios

Each Scenario declares whether it may change Target Application state, and Auto-QA rejects a plan containing Mutating Scenarios unless the Run was started with explicit mutation permission such as `--allow-mutations`. This permission covers browser interaction only, is surfaced in evidence, and is an intent check for trusted scripts rather than a security sandbox; application source edits remain separately controlled by the Run's Remediation Policy.
