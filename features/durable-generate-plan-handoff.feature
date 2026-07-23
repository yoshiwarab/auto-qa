# Scenario: Durable generate-plan handoff 001
Feature: Durable generate-plan handoff

  Scenario Outline: Durable generate-plan handoff 001
    Given a harness-assigned Run does not exist
    And the Change Inspector reports a <reported_change_kind> change at <reported_changed_path>
    When a start Event with a harness-supplied Base URL is dispatched for the Run
    Then the dispatch result exposes a generate-plan Job containing the <expected_change_kind> change at <expected_changed_path>
    And a restarted Workflow Engine returns the same generate-plan Job for the Run
    And the restarted Workflow Engine reports the Run in phase awaitingAgent

    Examples:
      | reported_change_kind | reported_changed_path | expected_change_kind | expected_changed_path |
      | modified             | src/dashboard.tsx     | modified             | src/dashboard.tsx     |
