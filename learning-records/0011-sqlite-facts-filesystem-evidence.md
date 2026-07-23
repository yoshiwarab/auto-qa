# SQLite owns workflow facts while the filesystem owns evidence artifacts

The learner correctly separated durable workflow state—Phase, Events, and the operation journal—from large browser artifacts such as recordings and console logs. The complete boundary also places Jobs, Scenarios, Scenario Scripts, Attempts, Findings, classifications, and evidence references in SQLite while raw Evidence Bundles remain on disk.
