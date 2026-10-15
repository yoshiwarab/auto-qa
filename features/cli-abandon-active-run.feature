# mutation-stamp: sha256=df864ba6b6fd50bc408af3342e662d791ede430764c395e1237435833ec6f157
# acceptance-mutation-manifest-begin
# {"version":1,"tested_at":"2026-09-23T21:31:32.154942046Z","feature_name":"CLI abandons an active Run","feature_path":"features/cli-abandon-active-run.feature","background_hash":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","implementation_hash":"sha256:fed9a1ebd5757ee3dcc74d7faa717781684ecb3c1229cd1d2e334ec808234fd0","scenarios":[{"index":0,"name":"CLI abandons an active Run 001","scenario_hash":"6b86c99c77ef0dc9c2831e247ad2150d87ca36de8140e5290448d167fc8ae4af","mutation_count":3,"result":{"Total":3,"Killed":3,"Survived":0,"Errors":0},"tested_at":"2026-07-28T18:59:42.863163006Z"}]}
# acceptance-mutation-manifest-end

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
    And the status envelope reports the first Run in phase <expected_phase> with reason <expected_reason>
    And the new start envelope reports a different Run in phase awaitingAgent

    Examples:
      | abandon_reason                 | expected_phase | expected_reason                |
      | superseded by updated changes | abandoned      | superseded by updated changes |
