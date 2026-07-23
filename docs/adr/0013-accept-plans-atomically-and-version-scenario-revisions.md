# Accept plans atomically and version Scenario Scripts

A `generate-plan` submission is accepted only when every Scenario passes schema and script validation; otherwise the same Job remains pending with actionable errors and no partial plan becomes active. Each accepted Scenario begins with immutable Scenario Script Version 0. Only an accepted replacement requested after a `test-issue` classification creates Version 1 or 2, so rejected lint corrections consume no replacement allowance and every Attempt records the exact frozen Script Version it executed.
