# mutation-stamp: sha256=e212d714c38379c254e7d3848d9c95c2dd82d8b5fa892f0386e3ceda94787b92
# acceptance-mutation-manifest-begin
# {"version":1,"tested_at":"2026-07-31T00:32:56.640646231Z","feature_name":"Atomic generate-plan rejection","feature_path":"features/atomic-generate-plan-rejection.feature","background_hash":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","implementation_hash":"sha256:15d2b776da4e79518c43d41d7ba3c6ea742a9defabaec31fc2d080f0ec641bb1","scenarios":[{"index":0,"name":"Atomic generate-plan rejection 001","scenario_hash":"2e5aa6400f98192f06a40b05e7bacc7469e52c81714361533dd0c1bb70c3c0ee","mutation_count":5,"result":{"Total":5,"Killed":5,"Survived":0,"Errors":0},"tested_at":"2026-07-30T18:27:12.980896520Z"}]}
# acceptance-mutation-manifest-end

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
