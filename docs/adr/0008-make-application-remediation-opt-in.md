# Make application remediation opt-in

Runs default to a `report-only` Remediation Policy that classifies Findings and produces evidence without authorizing application edits. An explicit `agent-fix` policy permits confirmed application defects to create `fix-application` Jobs; the coding agent performs the edits, submits completion, and Auto-QA reruns only affected Scenarios, while replacing a Scenario Script after a test issue remains part of verification rather than application remediation.
