import type {
  RunId,
  RunPhase,
} from "./workflowMachine.js";

export type Change = {
  readonly kind: string;
  readonly path: string;
};

export type GeneratePlanJob = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: "generate-plan";
  readonly runId: string;
  readonly payload: {
    readonly baseUrl: string;
    readonly changes: readonly Change[];
  };
};

export type AttemptStatus = "passed" | "failed";

export type AttemptRecord = {
  readonly scenarioId: string;
  readonly attemptNumber: number;
  readonly scriptVersion: number;
  readonly status: AttemptStatus;
  readonly evidencePath: string;
};

export type RunOutcome = "passed" | "defects-found" | "inconclusive";

export type AwaitingAgentDispatchResult = {
  readonly phase: "awaitingAgent";
  readonly pendingJob: GeneratePlanJob;
};

export type CompletedDispatchResult = {
  readonly phase: "completed";
  readonly outcome: RunOutcome;
  readonly attempts: readonly AttemptRecord[];
};

export type DispatchResult =
  | AwaitingAgentDispatchResult
  | CompletedDispatchResult;

type IdentifiedRunStatus = {
  readonly runId: RunId;
};

export type RunStatus = IdentifiedRunStatus &
  (
    | {
        readonly phase: Exclude<
          RunPhase,
          "abandoned" | "completed"
        >;
        readonly reason?: never;
        readonly outcome?: never;
        readonly attempts?: never;
      }
    | {
        readonly phase: "abandoned";
        readonly reason: string;
        readonly outcome?: never;
        readonly attempts?: never;
      }
    | {
        readonly phase: "completed";
        readonly outcome: RunOutcome;
        readonly attempts: readonly AttemptRecord[];
        readonly reason?: never;
      }
  );
