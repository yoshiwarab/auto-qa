# Keep the target application externally owned

Auto-QA v1 requires the Target Application to be running before a Run starts and will neither launch nor stop it. The Base URL is required Run input and must not be hardcoded in prompts, schemas, generated Scenario scripts, or production defaults; Auto-QA verifies reachability and injects the value into Scenario execution, while the test harness independently owns any fixture application process.
