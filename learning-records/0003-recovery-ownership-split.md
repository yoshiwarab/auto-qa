# Recovery policy, rerun judgment, and executable selection have separate owners

The learner correctly mapped recovery ownership: Auto-QA enforces that interrupted Scenarios cannot rerun silently, the coding agent decides whether to request an explicit rerun, and Auto-QA selects and enforces the exact accepted frozen Scenario Script Version for the next Attempt. The agent authors script content, but cannot substitute new bytes during rerun.
