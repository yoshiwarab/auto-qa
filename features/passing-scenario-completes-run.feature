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
