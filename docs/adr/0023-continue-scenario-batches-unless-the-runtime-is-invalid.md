# Continue Scenario batches unless the runtime is invalid

Sequential Scenario execution continues after assertions, script errors, and Scenario timeouts so one failure does not hide unrelated evidence. Auto-QA stops the batch only for mechanically typed run-wide failures such as expired authentication, an unreachable Target Application, or a broken browser runtime; shared-precondition meaning is left to later agent classification rather than inferred during automatic execution.
