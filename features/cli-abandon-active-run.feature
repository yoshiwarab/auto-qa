# Scenario: CLI abandons an active Run 001
Feature: CLI abandons an active Run

  Scenario Outline: CLI abandons an active Run 001
    Given a harness-owned temporary Git worktree has a committed baseline
    And a fresh CLI process has started the first Run with a harness-supplied Base URL
    When another fresh CLI process invokes runs abandon for the first Run with reason <abandon_reason>
    And a fresh status process reads the first Run
    And a fresh CLI process starts another Run in the same worktree with the same Base URL
    Then the abandon, status, and new start processes each exit successfully with empty stderr
    And each stdout contains exactly one schema-version 1 JSON success envelope with a correlation id
    And the status envelope reports the first Run in phase <expected_phase> with reason <abandon_reason>
    And the new start envelope reports a different Run in phase awaitingAgent

    Examples:
      | abandon_reason                 | expected_phase |
      | superseded by updated changes | abandoned      |
