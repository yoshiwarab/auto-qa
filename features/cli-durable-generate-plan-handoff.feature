# mutation-stamp: sha256=5a8b1c30729cba3d2d62c53551343f1a517b56d1cef93200da88d295e016f750
# acceptance-mutation-manifest-begin
# {"version":1,"tested_at":"2026-07-30T18:27:13.225044045Z","feature_name":"CLI durable generate-plan handoff","feature_path":"features/cli-durable-generate-plan-handoff.feature","background_hash":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","implementation_hash":"sha256:e28c0091285211ecf75d19c2d2894e37a8b61672aba165a3814b5aa33e0d9831","scenarios":[{"index":0,"name":"CLI durable generate-plan handoff 001","scenario_hash":"fcaf42a6350c4a2d3c2d6d5d73a2c81d5b5480cac8a71c94fe28a298087fd39d","mutation_count":3,"result":{"Total":3,"Killed":3,"Survived":0,"Errors":0},"tested_at":"2026-07-24T23:40:09.089053374Z"}]}
# acceptance-mutation-manifest-end

# Scenario: CLI durable generate-plan handoff 001
Feature: CLI durable generate-plan handoff

  Scenario Outline: CLI durable generate-plan handoff 001
    Given a harness-owned temporary Git worktree has a committed baseline
    And the file at <reported_changed_path> is modified after the baseline
    When a fresh CLI process starts a Run with a harness-supplied Base URL
    And separate fresh CLI processes invoke the job and status commands for the returned Run
    Then each process exits successfully with empty stderr
    And each stdout contains exactly one schema-version 1 JSON success envelope with a correlation id
    And the start and Job envelopes contain the same schema-version 1 generate-plan Job
    And the generate-plan Job contains a <expected_change_kind> change at <expected_changed_path>
    And the start and status envelopes report phase awaitingAgent

    Examples:
      | reported_changed_path | expected_change_kind | expected_changed_path |
      | src/dashboard.tsx     | modified             | src/dashboard.tsx     |
