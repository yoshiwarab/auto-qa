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
