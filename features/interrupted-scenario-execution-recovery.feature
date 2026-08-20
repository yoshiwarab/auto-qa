# Scenario: Interrupted Scenario execution recovery 001
Feature: Interrupted Scenario execution recovery

  Scenario Outline: Interrupted Scenario execution recovery 001
    Given two Workflow Engine processes share a fresh durable Run Store
    And the harness assigns Run interrupted-execution with a harness-supplied Base URL
    And the first process submits an accepted plan containing only Scenario <scenario_id> at Script Version <script_version>
    And execution of Attempt <attempt_number> is durably started with recovery policy <recovery_policy>
    And its Scenario Runtime is held after receiving the Attempt but before returning a result
    When the first process terminates without cleanup
    And the Process Identity boundary reports the recorded Turn owner as missing
    And the second process repeats the same generate-plan submission for the Run
    Then dispatch completes in phase <expected_phase> with a schema-version 1 <expected_job_type> Job
    And the Scenario Runtime has received Scenario <scenario_id> Attempt <attempt_number> at Script Version <script_version> exactly once across both processes
    And the Job contains exactly one Finding for that Attempt with mechanical status <expected_attempt_status> and cause <expected_finding_cause>
    And the Finding reports that no finalized Evidence Bundle is available
    And a fresh Workflow Engine returns the same pending Job and reports phase <expected_phase>
    And no Run report has been finalized

    Examples:
      | scenario_id   | script_version | attempt_number | recovery_policy   | expected_phase | expected_job_type  | expected_attempt_status | expected_finding_cause |
      | account-loads | 0              | 1              | record-interrupted | awaitingAgent  | classify-findings | interrupted             | interrupted            |
