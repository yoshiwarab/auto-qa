# Treat Scenario scripts as trusted local code

Auto-QA v1 executes agent-authored Scenario scripts as trusted local code with the same operating-system permissions as the CLI. Script validation exists to improve reliability, locator quality, timeout behavior, and accidental secret detection; it is not a security sandbox, and Auto-QA will not claim that Node isolation mechanisms make hostile scripts safe.
