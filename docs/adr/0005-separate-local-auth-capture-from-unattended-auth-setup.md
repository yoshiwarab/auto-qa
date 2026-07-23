# Separate local auth capture from unattended auth setup

Auto-QA will prepare authentication in two ways: local interactive capture creates a reusable gitignored Auth Profile, while unattended execution invokes an application-owned Auth Setup that creates fresh state from environment-provided test credentials or test-only authentication facilities. Auto-QA owns verification, secret-safe handling, and isolated Scenario contexts but does not encode provider-specific login behavior or transport a developer's captured personal session into CI.
