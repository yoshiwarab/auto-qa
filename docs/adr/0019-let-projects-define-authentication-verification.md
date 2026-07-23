# Let projects define authentication verification

`auto-qa.config.ts` may provide one trusted authentication verifier that receives a Playwright page and assertion interface and navigates relative to the Run's Base URL. Auto-QA reuses that verifier after local capture, unattended Auth Setup, and before authenticated Scenario execution, avoiding an expanding declarative indicator schema that could not express application-specific login semantics.
