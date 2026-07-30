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
