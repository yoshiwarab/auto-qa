# mutation-stamp: sha256=186e000510ce7c3359bc25593635f83ed10348a85043bea5bc9994a333b58fdb
# acceptance-mutation-manifest-begin
# {"version":1,"tested_at":"2026-09-23T21:31:32.570056221Z","feature_name":"Stale inspection Turn recovery","feature_path":"features/stale-inspection-turn-recovery.feature","background_hash":"00664b343c2fbe6fe9d0a349e5dfd059bf5b46f83341313aed8c9dd63f66152f","implementation_hash":"sha256:fc08f0341f5cae31f98c7cdc86292056b5a7299e88b4112e09826faa96b74e16","scenarios":[{"index":0,"name":"Stale inspection Turn recovery 001","scenario_hash":"86bcd31fbe933e8979ec2b6d5173425431153dee7f08ef1350cb396c65b410d3","mutation_count":12,"result":{"Total":12,"Killed":12,"Survived":0,"Errors":0},"tested_at":"2026-08-01T01:05:03.849771292Z"},{"index":1,"name":"Stale inspection Turn recovery 002","scenario_hash":"8124d2b324e1bb15fcff9021383c133277a1e43ed80b2121bd600293716e33dd","mutation_count":2,"result":{"Total":2,"Killed":2,"Survived":0,"Errors":0},"tested_at":"2026-08-01T01:05:03.849771292Z"}]}
# acceptance-mutation-manifest-end

# Scenario: Stale inspection Turn recovery 001
# Scenario: Stale inspection Turn recovery 002
Feature: Stale inspection Turn recovery

  Background:
    Given two Workflow Engine processes share a fresh durable Run Store
    And the harness assigns Run inspection-recovery with a harness-supplied Base URL

  Scenario Outline: Stale inspection Turn recovery 001
    Given the first process owns the Turn with ownership token stale-turn
    And it has durably recorded phase inspectingChanges with recovery policy rerun
    And its Change Inspector has not checkpointed completion
    And on recovery the Change Inspector reports a <reported_change_kind> change at <reported_changed_path>
    When the first process terminates without cleanup
    And the Process Identity boundary reports the recorded owner as <stale_owner_state>
    And the second process uses ownership token replacement-turn
    And it dispatches the same start Event for the Run and Base URL
    Then dispatch completes in phase <expected_phase> with a schema-version 1 generate-plan Job
    And the Job contains a <expected_change_kind> change at <expected_changed_path>
    And getPendingJob returns the same Job for the Run
    And getStatus reports the Run in phase <expected_phase>
    And no process outside the recorded Turn ownership is signaled

    Examples:
      | stale_owner_state | reported_change_kind | reported_changed_path | expected_phase | expected_change_kind | expected_changed_path |
      | missing           | modified             | src/account.tsx       | awaitingAgent  | modified             | src/account.tsx       |
      | pid-reused        | modified             | src/account.tsx       | awaitingAgent  | modified             | src/account.tsx       |

  Scenario Outline: Stale inspection Turn recovery 002
    Given the first process owns the Turn with ownership token active-turn
    And it has durably recorded phase inspectingChanges with recovery policy rerun
    And its Change Inspector remains held at a harness-controlled boundary
    And the Process Identity boundary confirms its recorded process id and start time still identify that live process
    When the second process uses ownership token contending-turn
    And it dispatches the same start Event for the Run and Base URL
    Then dispatch fails with <expected_error> identifying Run inspection-recovery
    And getStatus reports the Run in phase <expected_phase>
    And getPendingJob returns no Job for the Run
    And the first process remains held without being signaled

    Examples:
      | expected_error | expected_phase     |
      | RunBusyError   | inspectingChanges |
