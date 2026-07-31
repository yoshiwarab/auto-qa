# mutation-stamp: sha256=bc2e276fecbed7882fece54ab1e71c369a29577c79c96ec27a53ac44244abf60
# acceptance-mutation-manifest-begin
# {"version":1,"tested_at":"2026-07-31T00:32:57.308234871Z","feature_name":"CLI requires a Git worktree","feature_path":"features/cli-requires-git-worktree.feature","background_hash":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","implementation_hash":"sha256:4a43d072ef12c549c4f681925239782fdf2353100bad7b01dae35c9513e311cd","scenarios":[{"index":0,"name":"CLI requires a Git worktree 001","scenario_hash":"162260bb01b66a74b0942f755237452c95a7835226a5f746f75afd2a80110b1c","mutation_count":3,"result":{"Total":3,"Killed":3,"Survived":0,"Errors":0},"tested_at":"2026-07-30T00:22:44.547540409Z"}]}
# acceptance-mutation-manifest-end

# Scenario: CLI requires a Git worktree 001
Feature: CLI requires a Git worktree

  Scenario Outline: CLI requires a Git worktree 001
    Given a harness-owned temporary directory is outside every Git worktree
    When a fresh CLI process invokes start with a harness-supplied Base URL from that directory
    Then the process exits with code <expected_exit_code> and empty stderr
    And stdout contains exactly one schema-version 1 JSON failure envelope with a correlation id
    And the failure code is <expected_error_code>
    And the failure message is <expected_message>
    And no .auto-qa directory exists beneath the temporary directory

    Examples:
      | expected_exit_code | expected_error_code      | expected_message                        |
      | 1                  | GitWorktreeRequiredError | Auto-QA must run inside a Git worktree |
