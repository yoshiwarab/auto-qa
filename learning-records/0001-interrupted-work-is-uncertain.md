# Interrupted work represents uncertainty, not a resume point

The learner correctly identified that a Scenario recorded as `started` but not `completed` must be treated as interrupted rather than silently repeated. This establishes the core crash-recovery intuition: checkpoints preserve what may already have happened, and recovery policy decides whether repetition is safe.
