import { Data, Effect } from "effect";
import type { ScenarioSubmission } from "./planValidation.js";
import type { AttemptRecord } from "./workflowProtocol.js";

export type FrozenScenarioAttempt = {
  readonly runId: string;
  readonly scenario: ScenarioSubmission;
  readonly attemptNumber: 1;
  readonly scriptVersion: 0;
};

export type ScenarioEnvironment = {
  readonly baseUrl: URL;
};

export class ScenarioRuntimeError extends Data.TaggedError(
  "ScenarioRuntimeError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface ScenarioRuntime {
  readonly execute: (
    attempt: FrozenScenarioAttempt,
    environment: ScenarioEnvironment,
  ) => Effect.Effect<AttemptRecord, ScenarioRuntimeError>;
}
