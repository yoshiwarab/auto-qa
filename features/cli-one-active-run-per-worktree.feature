# mutation-stamp: sha256=9fa2f4074e6bc8b8f1c7c9c4c2f599fc47fc785c04a44f3e8e85e8549987d791
# acceptance-mutation-manifest-begin
# {"version":1,"tested_at":"2026-08-01T01:04:53.433465892Z","feature_name":"CLI one active Run per worktree","feature_path":"features/cli-one-active-run-per-worktree.feature","background_hash":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","implementation_hash":"sha256:b0b78f14b9be1e1c3bfdcbe87289c40b779244798035558ae59d3974ee66f5d2","scenarios":[{"index":0,"name":"CLI one active Run per worktree 001","scenario_hash":"67e8a6952c73720a01a1dace1f71151694302d99012a8d6c03a63efc81a5e56a","mutation_count":3,"result":{"Total":3,"Killed":3,"Survived":0,"Errors":0},"tested_at":"2026-07-25T03:52:22.910468841Z"}]}
# acceptance-mutation-manifest-end

# Scenario: CLI one active Run per worktree 001
Feature: CLI one active Run per worktree

  Scenario Outline: CLI one active Run per worktree 001
    Given a harness-owned temporary Git worktree has a committed baseline
    When a fresh CLI process starts the first Run with a harness-supplied Base URL
    And another fresh CLI process attempts to start a second Run in the same worktree with the same Base URL
    Then the first process exits successfully with empty stderr
    And the second process exits with code <expected_exit_code> and empty stderr
    And the second stdout contains exactly one schema-version 1 JSON failure envelope with a correlation id
    And the failure code is <expected_error_code>
    And the failure identifies the first Run by its returned Run id
    And a fresh status process reports the first Run in phase <expected_phase>

    Examples:
      | expected_exit_code | expected_error_code  | expected_phase |
      | 1                  | ActiveRunExistsError | awaitingAgent  |
