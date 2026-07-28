# Scenario: Workflow Engine fences a busy Turn 001
Feature: Workflow Engine fences a busy Turn

  Scenario Outline: Workflow Engine fences a busy Turn 001
    Given two Workflow Engines share a fresh durable Run Store
    And the first engine uses a Change Inspector held at a harness-controlled boundary
    When the first engine dispatches a start Event for a Run with a harness-supplied Base URL
    And the Change Inspector has begun and remains held
    And the second engine dispatches a start Event for a different Run
    Then the second engine dispatch returns while the Change Inspector remains held
    And the second engine dispatch fails with <expected_error> identifying the first Run
    And a concurrent getStatus call reports the first Run in phase <busy_phase>
    And a concurrent getPendingJob call returns no Job for the first Run
    When the harness releases the Change Inspector with no changes
    Then the first dispatch completes in phase <completed_phase> with a schema-version 1 generate-plan Job

    Examples:
      | expected_error | busy_phase        | completed_phase |
      | RunBusyError   | inspectingChanges | awaitingAgent   |
