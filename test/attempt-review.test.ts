import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  createWorkflowEngine,
  RunId,
  makeDeterministicScenarioRuntime,
} from "../src/index.js";
import { RunReportError } from "../src/runReporter.js";
import { ScenarioRuntimeError } from "../src/scenarioRuntime.js";

test("a mixed batch waits for durable review of every Attempt instead of reporting success", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-qa-review-"));
  const target = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  try {
    const address = target.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing address");
    const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
    const databasePath = join(root, "state.db");
    const runId = RunId("review-run");
    const executed: string[] = [];
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createWorkflowEngine({
            databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
            scenarioRuntime: {
              reconcile: () => Effect.void,
              execute: (attempt, environment) => {
                executed.push(attempt.scenario.id);
                return makeDeterministicScenarioRuntime(
                  attempt.scenario.id === "broken" ? "failed" : "passed"
                ).execute(attempt, environment);
              },
            },
          });
          const started = yield* engine.dispatch(runId, {
            type: "start",
            baseUrl,
          });
          return yield* engine.dispatch(runId, {
            type: "submitJob",
            jobId: started.pendingJob.id,
            payload: {
              schemaVersion: 1,
              scenarios: ["broken", "working"].map((id) => ({
                id,
                goal: `Review ${id}`,
                preconditions: [],
                mutates: false,
                script: "async () => {}",
              })),
            },
          });
        })
      )
    );
    expect(executed).toEqual(["broken", "working"]);
    expect(result).toMatchObject({
      phase: "awaitingAgent",
      pendingJob: {
        type: "classify-findings",
        payload: {
          findings: [
            {
              scenarioId: "broken",
              goal: "Review broken",
              mechanicalStatus: "failed",
            },
            {
              scenarioId: "working",
              goal: "Review working",
              mechanicalStatus: "passed",
              evidenceBundle: {
                captures: [
                  { screenshot: "final.png", accessibility: "final.aria.yaml" },
                ],
              },
            },
          ],
        },
      },
    });
    const pending = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const restarted = yield* createWorkflowEngine({
            databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
            readOnly: true,
          });
          return yield* restarted.getPendingJob(runId);
        })
      )
    );
    expect(result).toMatchObject({ pendingJob: pending });
    if (pending?.type !== "classify-findings")
      throw new Error("Expected review Job");
    const review = {
      schemaVersion: 1,
      resolution: "report-only",
      classifications: pending.payload.findings.map((finding) => ({
        findingId: finding.id,
        classification:
          finding.mechanicalStatus === "passed"
            ? "verified-success"
            : "app-defect",
        reasoning: "Reviewed the rendered result against the Scenario goal.",
        coverageComplete: true,
        reviewedEvidence: ["final.png", "final.aria.yaml"],
      })),
    };
    const completed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const restarted = yield* createWorkflowEngine({
            databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
          });
          const submission = {
            type: "submitJob",
            jobId: pending.id,
            payload: review,
          } as const;
          expect(
            yield* Effect.either(
              restarted.dispatch(runId, {
                ...submission,
                payload: {
                  ...review,
                  classifications: review.classifications.map((item) => ({
                    ...item,
                    classification: "verified-success",
                  })),
                },
              })
            )
          ).toMatchObject({
            _tag: "Left",
            left: { _tag: "FindingReviewError" },
          });
          const completed = yield* restarted.dispatch(runId, submission);
          expect(yield* restarted.dispatch(runId, submission)).toEqual(
            completed
          );
          return completed;
        })
      )
    );
    expect(completed).toMatchObject({
      phase: "completed",
      outcome: "defects-found",
      coverageIncomplete: false,
      attempts: [{ status: "failed" }, { status: "passed" }],
    });
    expect(
      JSON.parse(
        await readFile(join(root, "runs", runId, "report.json"), "utf8")
      )
    ).toEqual(completed);
  } finally {
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { classification: "verified-success", outcome: "passed", incomplete: false },
  { classification: "app-defect", outcome: "defects-found", incomplete: false },
  {
    classification: "likely-defect",
    outcome: "inconclusive",
    incomplete: true,
  },
  { classification: "observation", outcome: "inconclusive", incomplete: true },
  { classification: "test-issue", outcome: "inconclusive", incomplete: true },
  { classification: "infra-issue", outcome: "inconclusive", incomplete: true },
  {
    classification: "app-defect",
    outcome: "defects-found",
    incomplete: true,
    partialCoverage: true,
  },
  {
    classification: "verified-success",
    outcome: "rejected without captures",
    incomplete: true,
    noCapture: true,
  },
])(
  "a mechanical pass classified $classification reports $outcome",
  async (example) => {
    const root = await mkdtemp(join(tmpdir(), "auto-qa-review-matrix-"));
    const target = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve)
    );
    try {
      const address = target.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing address");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath: join(root, "state.db"),
              changeInspector: { inspect: () => Effect.succeed([]) },
              scenarioRuntime:
                "noCapture" in example
                  ? {
                      reconcile: () => Effect.void,
                      execute: (attempt, environment) =>
                        makeDeterministicScenarioRuntime()
                          .execute(attempt, environment)
                          .pipe(
                            Effect.map((execution) => ({
                              attempt: execution.attempt,
                            }))
                          ),
                    }
                  : makeDeterministicScenarioRuntime(),
            });
            const runId = RunId("matrix-run");
            const start = yield* engine.dispatch(runId, {
              type: "start",
              baseUrl: new URL(`http://127.0.0.1:${address.port}`),
            });
            const plan = {
              schemaVersion: 1,
              scenarios: [
                {
                  id: "visual",
                  goal: "Readable text",
                  preconditions: [],
                  mutates: false,
                  script: "async () => {}",
                },
              ],
            };
            const boundary = yield* engine.dispatch(runId, {
              type: "submitJob",
              jobId: start.pendingJob.id,
              payload: plan,
            });
            if (boundary.phase !== "awaitingAgent")
              throw new Error("Missing review boundary");
            const item = {
              findingId: "matrix-run:visual:1",
              classification: example.classification,
              reasoning: "Reviewed readability against the goal.",
              coverageComplete: !("partialCoverage" in example),
              reviewedEvidence:
                "noCapture" in example ? [] : ["final.png", "final.aria.yaml"],
            };
            for (const classifications of [
              [],
              [item, item],
              [{ ...item, findingId: "unknown" }],
              [{ ...item, reasoning: " " }],
              [{ ...item, reviewedEvidence: ["../other.png"] }],
              [
                {
                  ...item,
                  classification: "verified-success",
                  coverageComplete: false,
                },
              ],
              [
                {
                  ...item,
                  classification: "verified-success",
                  reviewedEvidence: ["final.aria.yaml"],
                },
              ],
            ]) {
              const rejected = yield* Effect.either(
                engine.dispatch(runId, {
                  type: "submitJob",
                  jobId: boundary.pendingJob.id,
                  payload: {
                    schemaVersion: 1,
                    resolution: "report-only",
                    classifications,
                  },
                })
              );
              expect(rejected).toMatchObject({
                _tag: "Left",
                left: { _tag: "FindingReviewError" },
              });
              expect(yield* engine.getPendingJob(runId)).toEqual(
                boundary.pendingJob
              );
            }
            const submission = {
              type: "submitJob",
              jobId: boundary.pendingJob.id,
              payload: {
                schemaVersion: 1,
                resolution: "report-only",
                classifications: [item],
              },
            } as const;
            if ("noCapture" in example) {
              expect(
                yield* Effect.either(engine.dispatch(runId, submission))
              ).toMatchObject({
                _tag: "Left",
                left: { _tag: "FindingReviewError" },
              });
              expect(yield* engine.getPendingJob(runId)).toEqual(
                boundary.pendingJob
              );
              return;
            }
            const result = yield* engine.dispatch(runId, submission);
            expect(result).toMatchObject({
              phase: "completed",
              outcome: example.outcome,
              coverageIncomplete: example.incomplete,
              attempts: [{ status: "passed" }],
            });
            expect(yield* engine.getStatus(runId)).toMatchObject(result);
            expect(yield* engine.dispatch(runId, submission)).toEqual(result);
            expect(
              yield* engine.dispatch(runId, {
                type: "submitJob",
                jobId: start.pendingJob.id,
                payload: plan,
              })
            ).toEqual(boundary);
            expect(
              yield* Effect.either(
                engine.dispatch(runId, {
                  ...submission,
                  payload: {
                    ...submission.payload,
                    classifications: [{ ...item, reasoning: "changed" }],
                  },
                })
              )
            ).toMatchObject({
              _tag: "Left",
              left: { _tag: "JobSubmissionConflictError" },
            });
          })
        )
      );
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
);

test("an interrupted batch reports skipped coverage and resumes accepted reporting without executing again", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-qa-review-recovery-"));
  const target = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  try {
    const address = target.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing address");
    const databasePath = join(root, "state.db");
    const runId = RunId("recovery-run");
    const submissions = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const executed: string[] = [];
          const engine = yield* createWorkflowEngine({
            databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
            scenarioRuntime: {
              reconcile: () => Effect.void,
              execute: (attempt, environment) => {
                executed.push(attempt.scenario.id);
                return attempt.scenario.id === "interrupted"
                  ? Effect.fail(
                      new ScenarioRuntimeError({
                        operation: "simulated interruption",
                        cause: "crashed",
                      })
                    )
                  : makeDeterministicScenarioRuntime().execute(
                      attempt,
                      environment
                    );
              },
            },
            runReporter: {
              writeReport: () =>
                Effect.fail(
                  new RunReportError({
                    operation: "simulated report write",
                    cause: "disk unavailable",
                  })
                ),
            },
          });
          const started = yield* engine.dispatch(runId, {
            type: "start",
            baseUrl: new URL(`http://127.0.0.1:${address.port}`),
          });
          const plan = {
            type: "submitJob",
            jobId: started.pendingJob.id,
            payload: {
              schemaVersion: 1,
              scenarios: ["passed", "interrupted", "unexecuted"].map((id) => ({
                id,
                goal: `Review ${id}`,
                preconditions: [],
                mutates: false,
                script: "async () => {}",
              })),
            },
          } as const;
          yield* Effect.either(engine.dispatch(runId, plan));
          const recovered = yield* engine.dispatch(runId, plan);
          expect(executed).toEqual(["passed", "interrupted"]);
          if (recovered.phase !== "awaitingAgent")
            throw new Error("Missing review Job");
          expect(recovered.pendingJob.payload.unexecutedScenarioIds).toEqual([
            "unexecuted",
          ]);
          const review = {
            type: "submitJob",
            jobId: recovered.pendingJob.id,
            payload: {
              schemaVersion: 1,
              resolution: "report-only",
              classifications: recovered.pendingJob.payload.findings.map(
                (finding) => ({
                  findingId: finding.id,
                  classification:
                    finding.mechanicalStatus === "passed"
                      ? "app-defect"
                      : "infra-issue",
                  reasoning:
                    "Reviewed available evidence; interrupted coverage remains uncertain.",
                  reviewedEvidence: finding.evidenceBundle?.files ?? [],
                  coverageComplete: finding.mechanicalStatus === "passed",
                })
              ),
            },
          } as const;
          expect(
            yield* Effect.either(engine.dispatch(runId, review))
          ).toMatchObject({ _tag: "Left", left: { _tag: "RunReportError" } });
          expect(yield* engine.getStatus(runId)).toMatchObject({
            phase: "reporting",
          });
          return { plan, review, boundary: recovered };
        })
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createWorkflowEngine({
            databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
            scenarioRuntime: {
              reconcile: () => Effect.void,
              execute: () => Effect.die("Must not execute on report recovery"),
            },
          });
          const result = yield* engine.dispatch(runId, submissions.review);
          expect(result).toMatchObject({
            phase: "completed",
            outcome: "defects-found",
            coverageIncomplete: true,
            incompleteScenarios: ["unexecuted", "interrupted"],
          });
          expect(yield* engine.dispatch(runId, submissions.plan)).toEqual(
            submissions.boundary
          );
        })
      )
    );
  } finally {
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
