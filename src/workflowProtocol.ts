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

export type AttemptStatus = "passed" | "failed" | "interrupted";

export type AttemptRecord = {
  readonly scenarioId: string;
  readonly attemptNumber: number;
  readonly scriptVersion: number;
  readonly status: AttemptStatus;
  readonly evidencePath: string | null;
};

export type FindingCause = "interrupted";

export type Finding = {
  readonly id: string;
  readonly scenarioId: string;
  readonly attemptNumber: number;
  readonly scriptVersion: number;
  readonly mechanicalStatus: AttemptStatus;
  readonly cause: FindingCause;
  readonly summary: string;
  readonly evidenceBundle: null;
};

export type ClassifyFindingsJob = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: "classify-findings";
  readonly runId: string;
  readonly payload: {
    readonly findings: readonly Finding[];
  };
};

export type Job = GeneratePlanJob | ClassifyFindingsJob;

export type RunOutcome = "passed" | "defects-found" | "inconclusive";

export type AwaitingAgentDispatchResult = {
  readonly phase: "awaitingAgent";
  readonly pendingJob: GeneratePlanJob;
};

export type ClassifyFindingsDispatchResult = {
  readonly phase: "awaitingAgent";
  readonly pendingJob: ClassifyFindingsJob;
};

export type CompletedDispatchResult = {
  readonly phase: "completed";
  readonly outcome: RunOutcome;
  readonly attempts: readonly AttemptRecord[];
};

export type DispatchResult =
  | AwaitingAgentDispatchResult
  | ClassifyFindingsDispatchResult
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
