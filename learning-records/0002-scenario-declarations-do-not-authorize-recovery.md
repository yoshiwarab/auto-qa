# Scenario declarations do not authorize crash recovery

The learner correctly explained that `mutatesApplication: false` is insufficient to authorize automatic repetition after an interrupted Attempt. Mutation declarations gate planned execution, while an incomplete journal creates runtime uncertainty that always requires an explicit rerun decision.
