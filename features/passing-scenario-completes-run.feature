# mutation-stamp: sha256=93af2916d227e34cad689ee864b6a37e28a817d5017c80f7630e3e7efab893aa
# acceptance-mutation-manifest-begin
# {"version":1,"tested_at":"2026-07-31T00:06:38.540557789Z","feature_name":"Passing Scenario completes a Run","feature_path":"features/passing-scenario-completes-run.feature","background_hash":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","implementation_hash":"sha256:653d756f74a27afb10b0f726071574b8ff377a346d8de97ce82ea60b0e65b81c","scenarios":[{"index":0,"name":"Passing Scenario completes a Run 001","scenario_hash":"ffa0f12eb22243afc710d75e12118c4431515e7958a35670dee78c97772816c9","mutation_count":10,"result":{"Total":10,"Killed":10,"Survived":0,"Errors":0},"tested_at":"2026-07-31T00:06:38.540557789Z"}]}
# acceptance-mutation-manifest-end

# Scenario: Passing Scenario completes a Run 001
Feature: Passing Scenario completes a Run

  Scenario Outline: Passing Scenario completes a Run 001
    Given a harness-owned temporary Git worktree has a committed baseline and one frontend change
    And a harness-owned Target Application serves accessible heading <served_heading> at a harness-supplied Base URL
    When a fresh CLI process starts a Run with that Base URL
    And a generate-plan submission for the returned Job contains one non-mutating Scenario <submitted_scenario_id>
    And its Scenario Script opens the injected Base URL and expects accessible heading <script_expected_heading>
    And another fresh CLI process submits that plan
    Then the submit process exits successfully
    And fresh job and status processes report no pending Job and phase <expected_phase> with Run Outcome <expected_outcome>
    And Scenario <expected_scenario_id> has exactly one Attempt numbered <expected_attempt_number> using Script Version <expected_script_version> with status <expected_attempt_status>
    And the finalized Evidence Bundle contains a schema-version <expected_evidence_schema_version> manifest listing result.json
    And result.json identifies Scenario <expected_scenario_id>, Attempt <expected_attempt_number>, Script Version <expected_script_version>, and status <expected_attempt_status>
    And report.md identifies Run Outcome <expected_outcome> and the passing Attempt
    And no temporary Evidence Bundle, registered browser resource, browser, context, or child process owned by Auto-QA remains
    And the harness-owned Target Application remains running

    Examples:
      | served_heading | script_expected_heading | submitted_scenario_id | expected_phase | expected_outcome | expected_scenario_id | expected_attempt_number | expected_script_version | expected_attempt_status | expected_evidence_schema_version |
      | Account        | Account                 | account-loads         | completed      | passed           | account-loads        | 1                       | 0                       | passed                  | 1                                |
