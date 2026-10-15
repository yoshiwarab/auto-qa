import { Effect } from "effect";
import type { AttemptStatus } from "./workflowProtocol.js";
import type { ScenarioRuntime } from "./scenarioRuntime.js";

export const makeDeterministicScenarioRuntime = (
  status: AttemptStatus = "passed"
): ScenarioRuntime => ({
  reconcile: () => Effect.void,
  execute: (attempt, environment) =>
    Effect.sync(() => {
      environment.checkpointActiveWork(0);
      return {
        evidence: {
          captureErrors: [],
          path: `runs/${attempt.runId}/scenarios/${attempt.scenario.id}/attempt-${attempt.attemptNumber}`,
          files: ["result.json", "final.png", "final.aria.yaml"],
          captures: [
            {
              name: "final",
              screenshot: "final.png",
              accessibility: "final.aria.yaml",
              viewport: { width: 1280, height: 720 },
            },
          ],
        },
        attempt: {
          scenarioId: attempt.scenario.id,
          attemptNumber: attempt.attemptNumber,
          scriptVersion: attempt.scriptVersion,
          status,
          evidencePath: `runs/${attempt.runId}/scenarios/${attempt.scenario.id}/attempt-${attempt.attemptNumber}`,
        },
      };
    }),
});
