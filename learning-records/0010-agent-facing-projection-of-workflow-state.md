# The agent sees a small projection of the richer workflow state

The learner identified that Auto-QA has one authoritative fine-grained state machine but exposes a much smaller interaction model to the coding agent: Auto-QA is working, a Job awaits an agent response, external repair is required, or the Run is finished. This projection explains why internal phases remain important for recovery while the agent primarily needs the pending Job and summarized status.
