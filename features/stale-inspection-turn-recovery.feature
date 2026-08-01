# Scenario: Stale inspection Turn recovery 001
# Scenario: Stale inspection Turn recovery 002
Feature: Stale inspection Turn recovery

  Background:
    Given two Workflow Engine processes share a fresh durable Run Store
    And the harness assigns Run inspection-recovery with a harness-supplied Base URL

  Scenario Outline: Stale inspection Turn recovery 001
    Given the first process owns the Turn with ownership token <first_ownership_token>
    And it has durably recorded phase inspectingChanges with recovery policy rerun
    And its Change Inspector has not checkpointed completion
    And on recovery the Change Inspector reports a <reported_change_kind> change at <reported_changed_path>
    When the first process terminates without cleanup
    And the Process Identity boundary reports the recorded owner as <stale_owner_state>
    And the second process uses ownership token <second_ownership_token>
    And it dispatches the same start Event for the Run and Base URL
    Then dispatch completes in phase <expected_phase> with a schema-version 1 generate-plan Job
    And the Job contains a <expected_change_kind> change at <expected_changed_path>
    And getPendingJob returns the same Job for the Run
    And getStatus reports the Run in phase <expected_phase>
    And no process outside the recorded Turn ownership is signaled

    Examples:
      | first_ownership_token | stale_owner_state | second_ownership_token | reported_change_kind | reported_changed_path | expected_phase | expected_change_kind | expected_changed_path |
      | stale-turn-001        | missing           | replacement-turn-001   | modified             | src/account.tsx       | awaitingAgent  | modified             | src/account.tsx       |
      | stale-turn-002        | pid-reused        | replacement-turn-002   | modified             | src/account.tsx       | awaitingAgent  | modified             | src/account.tsx       |

  Scenario Outline: Stale inspection Turn recovery 002
    Given the first process owns the Turn with ownership token <first_ownership_token>
    And it has durably recorded phase inspectingChanges with recovery policy rerun
    And its Change Inspector remains held at a harness-controlled boundary
    And the Process Identity boundary confirms its recorded process id and start time still identify that live process
    When the second process uses ownership token <second_ownership_token>
    And it dispatches the same start Event for the Run and Base URL
    Then dispatch fails with <expected_error> identifying Run inspection-recovery
    And getStatus reports the Run in phase <expected_phase>
    And getPendingJob returns no Job for the Run
    And the first process remains held without being signaled

    Examples:
      | first_ownership_token | second_ownership_token | expected_error | expected_phase     |
      | active-turn-001       | contending-turn-001    | RunBusyError   | inspectingChanges |
