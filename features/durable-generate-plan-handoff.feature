# mutation-stamp: sha256=df4da9857eeb10db535427d420dd3958e8cf8d2c65c8f4dc0d6ecf2d4739e1b2
# acceptance-mutation-manifest-begin
# {"version":1,"tested_at":"2026-07-30T23:19:59.273113411Z","feature_name":"Durable generate-plan handoff","feature_path":"features/durable-generate-plan-handoff.feature","background_hash":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","implementation_hash":"sha256:2890ac9dfd4865e2ab2af7f2d60e3794ba2263bb6c5aeed9d9990359c4ad0d98","scenarios":[{"index":0,"name":"Durable generate-plan handoff 001","scenario_hash":"1c709a7834d3f95d11da9d6e6092182182291e5ad9bd6c558cb12ca45fb8b46a","mutation_count":4,"result":{"Total":4,"Killed":4,"Survived":0,"Errors":0},"tested_at":"2026-07-24T02:58:22.818379252Z"}]}
# acceptance-mutation-manifest-end

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
