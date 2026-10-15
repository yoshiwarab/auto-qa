import { Schema } from "effect";
import { FindingClassification } from "./findingReview.js";
import type { RunId, RunPhase } from "./workflowMachine.js";

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
    readonly scriptInstructions: string;
  };
};

export type AttemptStatus = "passed" | "failed" | "interrupted";

const EvidenceFile = Schema.String.pipe(
  Schema.pattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
);
export const EvidenceBundle = Schema.Struct({
  path: Schema.String.pipe(
    Schema.pattern(
      /^runs\/[a-zA-Z0-9_-]+\/scenarios\/[a-zA-Z0-9_-]+\/attempt-[1-9][0-9]*$/
    )
  ),
  files: Schema.Array(EvidenceFile),
  captureErrors: Schema.Array(Schema.String),
  captures: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      screenshot: EvidenceFile,
      accessibility: EvidenceFile,
      viewport: Schema.Struct({
        width: Schema.Positive,
        height: Schema.Positive,
      }),
    })
  ),
});
export type EvidenceBundle = typeof EvidenceBundle.Type;

export const AttemptDiagnostic = Schema.Struct({
  kind: Schema.Literal("assertion", "script", "timeout"),
  message: Schema.String,
});
export type AttemptDiagnostic = typeof AttemptDiagnostic.Type;

export type AttemptRecord = {
  readonly scenarioId: string;
  readonly attemptNumber: number;
  readonly scriptVersion: number;
  readonly status: AttemptStatus;
  readonly evidencePath: string | null;
};

export const Finding = Schema.Struct({
  id: Schema.String,
  scenarioId: Schema.String,
  goal: Schema.String,
  attemptNumber: Schema.Number,
  scriptVersion: Schema.Number,
  mechanicalStatus: Schema.Literal("passed", "failed", "interrupted"),
  cause: Schema.Literal(
    "success",
    "assertion",
    "script",
    "timeout",
    "interrupted"
  ),
  summary: Schema.String,
  diagnostic: Schema.NullOr(AttemptDiagnostic),
  evidenceBundle: Schema.NullOr(EvidenceBundle),
});
export type Finding = typeof Finding.Type;
export type FindingCause = Finding["cause"];

export type ClassifyFindingsJob = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: "classify-findings";
  readonly runId: string;
  readonly payload: {
    readonly findings: readonly Finding[];
    readonly unexecutedScenarioIds: readonly string[];
    readonly instructions: string;
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

export const CompletedDispatchResult = Schema.Struct({
  phase: Schema.Literal("completed"),
  outcome: Schema.Literal("passed", "defects-found", "inconclusive"),
  attempts: Schema.Array(
    Schema.Struct({
      scenarioId: Schema.String,
      attemptNumber: Schema.Number,
      scriptVersion: Schema.Number,
      status: Schema.Literal("passed", "failed", "interrupted"),
      evidencePath: Schema.NullOr(Schema.String),
    })
  ),
  classifications: Schema.Array(FindingClassification),
  coverageIncomplete: Schema.Boolean,
  incompleteScenarios: Schema.Array(Schema.String),
});
export type CompletedDispatchResult = typeof CompletedDispatchResult.Type;

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
        readonly phase: Exclude<RunPhase, "abandoned" | "completed">;
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
    | (CompletedDispatchResult & {
        readonly reason?: never;
      })
  );
