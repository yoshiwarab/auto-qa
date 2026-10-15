import { Data, Effect, Schema } from "effect";
import type {
  ClassifyFindingsJob,
  CompletedDispatchResult,
} from "./workflowProtocol.js";

export const FindingClassification = Schema.Struct({
  findingId: Schema.NonEmptyTrimmedString,
  classification: Schema.Literal(
    "verified-success",
    "app-defect",
    "likely-defect",
    "observation",
    "test-issue",
    "infra-issue"
  ),
  reasoning: Schema.NonEmptyTrimmedString,
  coverageComplete: Schema.Boolean,
  reviewedEvidence: Schema.Array(Schema.String),
});
export type FindingClassification = typeof FindingClassification.Type;

const ReviewSubmission = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  resolution: Schema.Literal("report-only"),
  classifications: Schema.Array(FindingClassification),
});

export class FindingReviewError extends Data.TaggedError("FindingReviewError")<{
  readonly message: string;
}> {}

/** Report-only is explicit: uncertain coverage is reported, never silently retried. */
export const reviewFindings = (job: ClassifyFindingsJob, payload: unknown) =>
  Effect.gen(function* () {
    const submission = yield* Schema.decodeUnknown(ReviewSubmission)(
      payload
    ).pipe(
      Effect.mapError(
        (error) =>
          new FindingReviewError({
            message: `Invalid classify-findings submission: ${error.message}`,
          })
      )
    );
    const classifications = submission.classifications;
    const ids = new Set(classifications.map((item) => item.findingId));
    if (
      ids.size !== classifications.length ||
      ids.size !== job.payload.findings.length ||
      job.payload.findings.some((finding) => !ids.has(finding.id))
    ) {
      return yield* Effect.fail(
        new FindingReviewError({
          message:
            "Classify every listed Finding exactly once; unknown, missing, and duplicate Findings are rejected",
        })
      );
    }
    const incompleteScenarios: string[] = [
      ...job.payload.unexecutedScenarioIds,
    ];
    for (const item of classifications) {
      const finding = job.payload.findings.find(
        (candidate) => candidate.id === item.findingId
      );
      if (finding === undefined)
        return yield* Effect.fail(
          new FindingReviewError({ message: "Unknown Finding" })
        );
      const evidence = finding.evidenceBundle;
      if (
        new Set(item.reviewedEvidence).size !== item.reviewedEvidence.length ||
        item.reviewedEvidence.some((file) => !evidence?.files.includes(file))
      ) {
        return yield* Effect.fail(
          new FindingReviewError({
            message: `Reviewed evidence for ${item.findingId} must name unique files from that Finding's Evidence Bundle`,
          })
        );
      }
      if (
        item.classification === "verified-success" &&
        (!item.coverageComplete ||
          finding.mechanicalStatus !== "passed" ||
          !evidence?.captures.length ||
          evidence.captures.some(
            (capture) =>
              !item.reviewedEvidence.includes(capture.screenshot) ||
              !item.reviewedEvidence.includes(capture.accessibility)
          ))
      ) {
        return yield* Effect.fail(
          new FindingReviewError({
            message: `verified-success requires complete coverage, a mechanical pass, and review of every screenshot and accessibility snapshot for ${item.findingId}`,
          })
        );
      }
      if (
        finding.cause === "interrupted" &&
        item.classification !== "infra-issue"
      ) {
        return yield* Effect.fail(
          new FindingReviewError({
            message:
              "An interrupted Attempt requires infra-issue for an inconclusive report-only resolution",
          })
        );
      }
      if (
        !item.coverageComplete ||
        (item.classification !== "verified-success" &&
          item.classification !== "app-defect")
      )
        incompleteScenarios.push(finding.scenarioId);
    }
    const result: CompletedDispatchResult = {
      phase: "completed",
      outcome: classifications.some(
        (item) => item.classification === "app-defect"
      )
        ? "defects-found"
        : incompleteScenarios.length
          ? "inconclusive"
          : "passed",
      coverageIncomplete: incompleteScenarios.length > 0,
      incompleteScenarios,
      classifications,
      attempts: job.payload.findings.map((finding) => ({
        scenarioId: finding.scenarioId,
        attemptNumber: finding.attemptNumber,
        scriptVersion: finding.scriptVersion,
        status: finding.mechanicalStatus,
        evidencePath: finding.evidenceBundle?.path ?? null,
      })),
    };
    return result;
  });
