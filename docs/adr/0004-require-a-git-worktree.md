# Require a Git worktree

Auto-QA v1 requires `start` to run within a Git worktree because repository changes are essential input to Scenario planning; otherwise it fails before creating a Run with a typed machine-readable error. Branch topology remains optional and flexible: unborn repositories, detached HEAD, missing `main`, staged and unstaged changes, and untracked files are supported, and the selected comparison strategy is reported rather than implied.
