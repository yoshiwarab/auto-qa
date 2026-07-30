# Scenario: Atomic generate-plan rejection 001
Feature: Atomic generate-plan rejection

  Scenario Outline: Atomic generate-plan rejection 001
    Given a Run is awaiting a schema-version 1 generate-plan Job
    And the Job submission contains valid Scenario dashboard-loads
    And the same submission contains Scenario <submitted_invalid_scenario_id> with required field <omitted_field> omitted
    When the plan is submitted through the Workflow Engine for the pending Job
    Then dispatch fails with error <expected_error_code> naming Scenario <expected_invalid_scenario_id> and required field <expected_field>
    And the Run remains in phase awaitingAgent
    And a restarted Workflow Engine returns the unchanged generate-plan Job

    Examples:
      | submitted_invalid_scenario_id | omitted_field | expected_error_code | expected_invalid_scenario_id | expected_field |
      | checkout-submits              | goal          | PlanValidationError | checkout-submits             | goal           |
