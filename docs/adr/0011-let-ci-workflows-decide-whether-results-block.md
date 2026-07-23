# Let CI workflows decide whether results block

In CI Mode, Auto-QA will fail closed by returning a nonzero result for `defects-found`, `inconclusive`, `blocked`, or an Auto-QA failure, with structured output distinguishing each case. Whether that result blocks a merge is owned by the surrounding CI workflow through its normal advisory or continue-on-error facilities; Auto-QA will not add a separate gating-policy configuration that could obscure its QA verdict.
