import { Data, Effect } from "effect";
import type { InvalidTransitionError, RunId } from "./workflowMachine.js";
import type { PlanLimits, ScenarioSubmission } from "./planValidation.js";
import type {
  AttemptRecord,
  CompletedDispatchResult,
  GeneratePlanJob,
  ClassifyFindingsJob,
  Job,
  RunStatus,
  Finding,
  DispatchResult,
} from "./workflowProtocol.js";
import type {
  ProcessIdentityError,
  ProcessIdentityRecord,
} from "./processIdentity.js";

export type JobSubmissionState = {
  readonly status: "pending" | "accepted" | "completed";
  readonly submissionHash: string | null;
  readonly result: DispatchResult | null;
};

export class WorkflowStoreError extends Data.TaggedError("WorkflowStoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{
  readonly runId: string;
}> {}

export class ActiveRunExistsError extends Data.TaggedError(
  "ActiveRunExistsError"
)<{
  readonly activeRunId: string;
}> {}

export class RunBusyError extends Data.TaggedError("RunBusyError")<{
  readonly owningRunId: string | null;
}> {}

export class TurnOwnershipLostError extends Data.TaggedError(
  "TurnOwnershipLostError"
)<{
  readonly ownershipToken: string;
}> {}

export type RecoveryPolicy = "rerun" | "record-interrupted";

export type TurnOwner = ProcessIdentityRecord & {
  readonly ownershipToken: string;
};

export type TurnLease = {
  readonly ownershipToken: string;
  readonly recoveredStaleOwner: boolean;
};

export type RunRecord = RunStatus & {
  readonly baseUrl: URL;
  readonly planLimits: PlanLimits;
};

export interface RunStore {
  readonly acquireTurn: (
    /** null reserves the worktree lock for cleanup without creating a Run. */
    runId: RunId | null,
    owner: TurnOwner
  ) => Effect.Effect<
    TurnLease,
    ProcessIdentityError | RunBusyError | WorkflowStoreError
  >;
  readonly releaseTurn: (
    lease: TurnLease
  ) => Effect.Effect<void, WorkflowStoreError>;
  readonly loadRun: (
    runId: RunId
  ) => Effect.Effect<RunRecord | null, WorkflowStoreError>;
  readonly startInspection: (
    lease: TurnLease,
    runId: RunId,
    baseUrl: URL,
    recoveryPolicy: RecoveryPolicy,
    planLimits: PlanLimits
  ) => Effect.Effect<
    void,
    ActiveRunExistsError | TurnOwnershipLostError | WorkflowStoreError
  >;
  readonly completeInspection: (
    lease: TurnLease,
    runId: RunId,
    job: GeneratePlanJob
  ) => Effect.Effect<void, TurnOwnershipLostError | WorkflowStoreError>;
  readonly acceptPlan: (
    lease: TurnLease,
    runId: RunId,
    scenarios: readonly ScenarioSubmission[],
    submissionHash: string
  ) => Effect.Effect<
    readonly ScenarioSubmission[],
    TurnOwnershipLostError | WorkflowStoreError
  >;
  readonly completeAttempt: (
    lease: TurnLease,
    runId: RunId,
    attempt: AttemptRecord,
    nextScenarioId: string | undefined,
    finding: Finding
  ) => Effect.Effect<void, TurnOwnershipLostError | WorkflowStoreError>;
  readonly recordInterruptedScenario: (
    lease: TurnLease,
    runId: RunId
  ) => Effect.Effect<
    ClassifyFindingsJob | null,
    TurnOwnershipLostError | WorkflowStoreError
  >;
  readonly acceptReview: (
    lease: TurnLease,
    runId: RunId,
    jobId: string,
    submissionHash: string,
    result: CompletedDispatchResult
  ) => Effect.Effect<void, TurnOwnershipLostError | WorkflowStoreError>;
  readonly completeReport: (
    lease: TurnLease,
    runId: RunId,
    result: CompletedDispatchResult
  ) => Effect.Effect<void, TurnOwnershipLostError | WorkflowStoreError>;
  readonly getJobSubmission: (
    runId: RunId,
    jobId: string
  ) => Effect.Effect<JobSubmissionState | null, WorkflowStoreError>;
  readonly getActiveWorkMs: (
    runId: RunId
  ) => Effect.Effect<number, WorkflowStoreError>;
  readonly recordActiveWorkMs: (
    lease: TurnLease,
    runId: RunId,
    elapsedMs: number
  ) => Effect.Effect<void, TurnOwnershipLostError | WorkflowStoreError>;
  readonly getPendingJob: (
    runId: RunId
  ) => Effect.Effect<Job | null, WorkflowStoreError>;
  readonly getStatus: (
    runId: RunId
  ) => Effect.Effect<RunStatus, RunNotFoundError | WorkflowStoreError>;
  readonly abandon: (
    lease: TurnLease,
    runId: RunId,
    reason: string
  ) => Effect.Effect<
    RunStatus,
    | RunNotFoundError
    | InvalidTransitionError
    | TurnOwnershipLostError
    | WorkflowStoreError
  >;
}
