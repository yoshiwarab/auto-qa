import { Data, Effect, type Scope } from "effect";
import type { ScenarioSubmission } from "./planValidation.js";
import type {
  AttemptRecord,
  EvidenceBundle,
  AttemptDiagnostic,
} from "./workflowProtocol.js";
export type { AttemptDiagnostic } from "./workflowProtocol.js";

export type FrozenScenarioAttempt = {
  readonly runId: string;
  readonly scenario: ScenarioSubmission;
  readonly attemptNumber: AttemptRecord["attemptNumber"];
  readonly scriptVersion: AttemptRecord["scriptVersion"];
};

export type ScenarioEnvironment = {
  readonly baseUrl: URL;
  readonly timeoutMs: number;
  readonly checkpointActiveWork: (elapsedMs: number) => void;
};

export type ScenarioExecution = {
  readonly attempt: AttemptRecord;
  readonly diagnostic?: AttemptDiagnostic;
  readonly evidence?: EvidenceBundle;
};

export class ScenarioRuntimeError extends Data.TaggedError(
  "ScenarioRuntimeError"
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface ScenarioRuntime {
  /** Bounded launch/evidence time outside the Script timeout; cleanup is scoped separately. */
  readonly executionOverheadMs?: number;
  /** Reconcile owned resources only while the caller holds the worktree Turn. */
  readonly reconcile: () => Effect.Effect<void, ScenarioRuntimeError>;
  /** Return finalized evidence before cleanup. Register cleanup in the caller's
   * per-Attempt Scope, which closes outside active-work deadlines and before
   * the next Scenario or Turn release. */
  readonly execute: (
    attempt: FrozenScenarioAttempt,
    environment: ScenarioEnvironment
  ) => Effect.Effect<ScenarioExecution, ScenarioRuntimeError, Scope.Scope>;
}
