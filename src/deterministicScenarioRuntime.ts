import { Effect } from "effect";
import type { AttemptStatus } from "./workflowProtocol.js";
import type { ScenarioRuntime } from "./scenarioRuntime.js";

export const makeDeterministicScenarioRuntime = (
  status: AttemptStatus = "passed",
): ScenarioRuntime => ({
  execute: (attempt) =>
    Effect.succeed({
      scenarioId: attempt.scenario.id,
      attemptNumber: attempt.attemptNumber,
      scriptVersion: attempt.scriptVersion,
      status,
      evidencePath: `runs/${attempt.runId}/scenarios/${attempt.scenario.id}/attempt-${attempt.attemptNumber}`,
    }),
});
