# mutation-stamp: sha256=6c2f17a86af928a810a672de49bf28e4989358dd6b444bb6cd29af222c0a9911
# acceptance-mutation-manifest-begin
# {"version":1,"tested_at":"2026-07-30T00:28:21.127522807Z","feature_name":"Workflow Engine fences a busy Turn","feature_path":"features/workflow-engine-fenced-turn.feature","background_hash":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","implementation_hash":"sha256:3045346377056ce0e74e2445a8a926ee7b3313bf3ed76d5aeca8ddd4b06d552e","scenarios":[{"index":0,"name":"Workflow Engine fences a busy Turn 001","scenario_hash":"f6651ee669447ca5b0423cc140cbf8f4e2ce1e6bbd33aac22fe6555f047d3086","mutation_count":3,"result":{"Total":3,"Killed":3,"Survived":0,"Errors":0},"tested_at":"2026-07-29T00:10:23.758956452Z"}]}
# acceptance-mutation-manifest-end

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
