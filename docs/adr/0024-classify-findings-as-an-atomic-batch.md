# Classify Findings as an atomic batch

After each execution batch, Auto-QA creates one `classify-findings` Job containing every new unclassified Finding with its Scenario, Attempt, summary, and Evidence Bundle links. The agent must classify every listed Finding exactly once in one atomic submission before routing begins, giving it cross-failure context and avoiding a separate Turn for each Finding; later execution batches create their own classification Jobs.
