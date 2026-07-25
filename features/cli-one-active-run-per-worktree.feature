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
