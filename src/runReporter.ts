import { Data, Effect } from "effect";
import type { AttemptRecord } from "./workflowProtocol.js";

export class RunReportError extends Data.TaggedError("RunReportError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface RunReporter {
  readonly writePassingReport: (
    runId: string,
    attempts: readonly AttemptRecord[],
  ) => Effect.Effect<void, RunReportError>;
}
