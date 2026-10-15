import { Data, Effect } from "effect";
import type { CompletedDispatchResult } from "./workflowProtocol.js";

export class RunReportError extends Data.TaggedError("RunReportError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface RunReporter {
  readonly writeReport: (
    runId: string,
    result: CompletedDispatchResult
  ) => Effect.Effect<void, RunReportError>;
}
