# Use a committed TypeScript project configuration

Auto-QA will read optional reviewable project settings from `auto-qa.config.ts`, including authentication verification, application-owned Auth Setup, Run Retention, Scenario limits, and evidence defaults. Run-specific Base URLs and secrets are forbidden from the configuration, while `.auto-qa/` remains the gitignored home for SQLite state, Auth Profiles, registries, and Evidence Bundles.
