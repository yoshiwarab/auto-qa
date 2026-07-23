# Rerun defect Scenarios and agent-declared affected coverage

After an authorized application fix, Auto-QA always reruns the existing Scenarios associated with the Confirmed Defects addressed by the `fix-application` Job and permits the agent to name additional affected Scenarios from the accepted plan. Auto-QA validates those identifiers but does not infer coverage from filenames or add new Scenarios; new coverage requires a new Run with a newly accepted atomic plan.
