import { Data, Effect } from "effect";
import type {
  GeneratePlanJob,
  RunId,
  RunPhase,
  RunStatus,
} from "./workflowEngine.js";

export class WorkflowStoreError extends Data.TaggedError(
  "WorkflowStoreError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{
  readonly runId: string;
}> {}

export class ActiveRunExistsError extends Data.TaggedError(
  "ActiveRunExistsError",
)<{
  readonly activeRunId: string;
}> {}

export class RunBusyError extends Data.TaggedError("RunBusyError")<{
  readonly owningRunId: string;
}> {}

export class TurnOwnershipLostError extends Data.TaggedError(
  "TurnOwnershipLostError",
)<{
  readonly ownershipToken: string;
}> {}

export type RecoveryPolicy = "rerun";

export type TurnOwner = {
  readonly processId: number;
  readonly processStartedAt: string;
  readonly ownershipToken: string;
};

export type TurnLease = {
  readonly ownershipToken: string;
};

export type RunRecord = {
  readonly runId: RunId;
  readonly phase: RunPhase;
  readonly baseUrl: URL;
};

export interface RunStore {
  readonly acquireTurn: (
    runId: RunId,
    owner: TurnOwner,
  ) => Effect.Effect<
    TurnLease,
    RunBusyError | WorkflowStoreError
  >;
  readonly releaseTurn: (
    lease: TurnLease,
  ) => Effect.Effect<void, WorkflowStoreError>;
  readonly loadRun: (
    runId: RunId,
  ) => Effect.Effect<RunRecord | null, WorkflowStoreError>;
  readonly startInspection: (
    lease: TurnLease,
    runId: RunId,
    baseUrl: URL,
    recoveryPolicy: RecoveryPolicy,
  ) => Effect.Effect<
    void,
    | ActiveRunExistsError
    | TurnOwnershipLostError
    | WorkflowStoreError
  >;
  readonly completeInspection: (
    lease: TurnLease,
    runId: RunId,
    job: GeneratePlanJob,
  ) => Effect.Effect<
    void,
    TurnOwnershipLostError | WorkflowStoreError
  >;
  readonly getPendingJob: (
    runId: RunId,
  ) => Effect.Effect<GeneratePlanJob | null, WorkflowStoreError>;
  readonly getStatus: (
    runId: RunId,
  ) => Effect.Effect<
    RunStatus,
    RunNotFoundError | WorkflowStoreError
  >;
}
