# Use Jobs rather than phases to describe agent input

Auto-QA will use one ordinary agent Input Boundary, `awaitingAgent`, where the pending Job identifies whether the Run needs a plan, Finding classification, replacement Scenario Script, or application fix. The external `SUBMIT_JOB` event is generic, while a pure guard checks the current Job id and validates its job-specific payload before transition; this replaces misleading phases such as `awaitingFix` and prevents every new Job type from expanding the state-machine vocabulary.
