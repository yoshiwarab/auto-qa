# Keep CI Mode agent-driven

Auto-QA v1's `--ci` flag configures headless execution, evidence capture, and exit-code policy but does not remove the coding agent from the Job protocol. A normal unattended CI job cannot generate plans, classify Findings, or respond to Jobs; autonomous providers, pre-authored durable specifications, and agentless CI orchestration remain outside v1.
