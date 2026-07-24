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

export type DispatchResult = {
  readonly phase: "awaitingAgent";
  readonly pendingJob: GeneratePlanJob;
};

export type RunStatus = {
  readonly runId: RunId;
  readonly phase: RunPhase;
};
