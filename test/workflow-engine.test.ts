import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Deferred, Effect, Fiber, TestClock, TestContext } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  ActiveRunExistsError,
  ChangeInspectionError,
  type ChangeInspector,
  InvalidTransitionError,
  makeDeterministicScenarioRuntime,
  RunId,
  RunBusyError,
  RunNotFoundError,
  TurnOwnershipLostError,
  WorkflowStoreError,
  createWorkflowEngine,
} from "../src/index.js";
import { openSqliteRunStore } from "../src/sqliteRunStore.js";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const parent = join(process.cwd(), "tmp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "workflow-engine-"));
  temporaryDirectories.push(directory);
  return directory;
};

const withHarnessBaseUrl = async <Result>(
  use: (baseUrl: URL) => Promise<Result>
): Promise<Result> => {
  const targetApplication = createServer((_request, response) => {
    response.end("ok");
  });

  await new Promise<void>((resolve) => {
    targetApplication.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = targetApplication.address() as AddressInfo;
    return await use(new URL(`http://127.0.0.1:${address.port}`));
  } finally {
    await new Promise<void>((resolve, reject) => {
      targetApplication.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
};

const createNoChangeWorkflowEngine = (databasePath: string, readOnly = false) =>
  createWorkflowEngine({
    databasePath,
    changeInspector: {
      inspect: () => Effect.succeed([]),
    },
    readOnly,
    scenarioRuntime: makeDeterministicScenarioRuntime(),
    runReporter: {
      writeReport: () => Effect.void,
    },
  });

const replaceTurnIncarnationWithLegacyTimestamp = (
  databasePath: string
): void => {
  const database = new DatabaseSync(databasePath);
  database
    .prepare("UPDATE turn_lock SET process_started_at = ? WHERE lock_id = 1")
    .run("2026-07-31T20:00:00.000Z");
  database.close();
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true }))
  );
});

describe("WorkflowEngine durable generate-plan handoff", () => {
  test("cleanup holds the worktree lock without inventing a Run and releases it afterward", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const blocked = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const owner = yield* createWorkflowEngine({
            databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
            scenarioRuntime: {
              ...makeDeterministicScenarioRuntime(),
              reconcile: () =>
                Effect.zipRight(
                  Deferred.succeed(entered, undefined),
                  Deferred.await(release)
                ),
            },
          });
          const cleanup = yield* Effect.forkScoped(owner.cleanup());
          yield* Deferred.await(entered);
          const contender = yield* createNoChangeWorkflowEngine(databasePath);
          const result = yield* Effect.either(contender.cleanup());
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(cleanup);
          yield* contender.cleanup();
          return result;
        })
      )
    );
    expect(blocked).toMatchObject({
      _tag: "Left",
      left: { _tag: "RunBusyError", owningRunId: null },
    });
  });

  test("a Run with no durable state has no pending Job", async () => {
    const directory = await makeTemporaryDirectory();
    const pendingJob = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createNoChangeWorkflowEngine(
            join(directory, "state.db")
          );
          return yield* engine.getPendingJob(RunId("missing-run"));
        })
      )
    );

    expect(pendingJob).toBeNull();
  });

  test("an unavailable database is reported as a typed store failure", async () => {
    const directory = await makeTemporaryDirectory();
    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          createWorkflowEngine({
            databasePath: join(directory, "missing", "state.db"),
            changeInspector: {
              inspect: () => Effect.succeed([]),
            },
          })
        )
      )
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WorkflowStoreError);
      expect(result.left).toMatchObject({
        operation: "open Run Store",
      });
    }
  });

  test("a restarted engine returns the generate-plan Job created by start", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-001");
    const changeInspector: ChangeInspector = {
      inspect: () =>
        Effect.succeed([
          { kind: "modified", path: "src/dashboard.tsx" },
        ] as const),
    };

    await withHarnessBaseUrl(async (baseUrl) => {
      const expectedJob = {
        schemaVersion: 1,
        id: "run-001:generate-plan:1",
        type: "generate-plan",
        runId: "run-001",
        payload: {
          baseUrl: baseUrl.href,
          changes: [{ kind: "modified", path: "src/dashboard.tsx" }],
          scriptInstructions: expect.stringContaining(
            "baseUrl is a URL object"
          ),
        },
      };

      const dispatchResult = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector,
            });
            return yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
          })
        )
      );

      expect(dispatchResult).toEqual({
        phase: "awaitingAgent",
        pendingJob: expectedJob,
      });

      const restartedState = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector,
            });
            return {
              job: yield* engine.getPendingJob(runId),
              status: yield* engine.getStatus(runId),
            };
          })
        )
      );

      expect(restartedState).toEqual({
        job: expectedJob,
        status: {
          runId: "run-001",
          phase: "awaitingAgent",
        },
      });
    });
  });

  test("a mixed invalid plan is rejected atomically", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-invalid-plan");

    await withHarnessBaseUrl(async (baseUrl) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createNoChangeWorkflowEngine(databasePath);
            const started = yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
            const rejected = yield* Effect.either(
              engine.dispatch(runId, {
                type: "submitJob",
                jobId: started.pendingJob.id,
                payload: {
                  schemaVersion: 1,
                  scenarios: [
                    {
                      id: "dashboard-loads",
                      goal: "Show the dashboard",
                      preconditions: [],
                      mutates: false,
                      script:
                        "async ({ page }) => { await page.goto('/dashboard'); }",
                    },
                    {
                      id: "checkout-submits",
                      preconditions: ["a product is in the cart"],
                      mutates: true,
                      script:
                        "async ({ page }) => { await page.getByRole('button', { name: 'Checkout' }).click(); }",
                    },
                  ],
                },
              })
            );
            return { rejected, pendingJob: started.pendingJob };
          })
        )
      );

      expect(result.rejected).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "PlanValidationError",
          scenarioId: "checkout-submits",
          field: "goal",
          message: "Scenario checkout-submits is missing required field goal",
        },
      });

      const restarted = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createNoChangeWorkflowEngine(databasePath);
            return {
              status: yield* engine.getStatus(runId),
              pendingJob: yield* engine.getPendingJob(runId),
              validSubmission: yield* Effect.either(
                engine.dispatch(runId, {
                  type: "submitJob",
                  jobId: result.pendingJob.id,
                  payload: {
                    schemaVersion: 1,
                    scenarios: [
                      {
                        id: "dashboard-loads",
                        goal: "Show the dashboard",
                        preconditions: ["the dashboard is available"],
                        mutates: false,
                        script:
                          "async ({ page }) => { await page.goto('/dashboard'); }",
                      },
                    ],
                  },
                })
              ),
            };
          })
        )
      );

      expect(restarted).toMatchObject({
        status: {
          runId,
          phase: "awaitingAgent",
        },
        pendingJob: result.pendingJob,
        validSubmission: {
          _tag: "Right",
          right: {
            phase: "awaitingAgent",
            pendingJob: {
              type: "classify-findings",
              payload: {
                findings: [
                  {
                    scenarioId: "dashboard-loads",
                    attemptNumber: 1,
                    scriptVersion: 0,
                    mechanicalStatus: "passed",
                  },
                ],
              },
            },
          },
        },
      });
    });
  });

  test("malformed Scenario identities produce stable plan errors", async () => {
    const directory = await makeTemporaryDirectory();
    const examples: readonly {
      readonly scenario: unknown;
      readonly message: string;
    }[] = [
      {
        scenario: null,
        message: "Scenario <unknown> is missing required field id",
      },
      {
        scenario: "not a Scenario",
        message: "Scenario <unknown> is missing required field id",
      },
      {
        scenario: { id: { length: 1 } },
        message: "Scenario <unknown> has invalid required field id",
      },
      {
        scenario: { id: "" },
        message: "Scenario <unknown> has invalid required field id",
      },
      {
        scenario: { id: "../escape" },
        message: "Scenario <unknown> has invalid required field id",
      },
    ];

    await withHarnessBaseUrl(async (baseUrl) => {
      for (const [index, example] of examples.entries()) {
        const runId = RunId(`run-malformed-plan-${index}`);
        const rejected = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createNoChangeWorkflowEngine(
                join(directory, `state-${index}.db`)
              );
              const started = yield* engine.dispatch(runId, {
                type: "start",
                baseUrl,
              });
              return yield* Effect.either(
                engine.dispatch(runId, {
                  type: "submitJob",
                  jobId: started.pendingJob.id,
                  payload: {
                    schemaVersion: 1,
                    scenarios: [example.scenario],
                  },
                })
              );
            })
          )
        );

        expect(rejected).toMatchObject({
          _tag: "Left",
          left: {
            _tag: "PlanValidationError",
            scenarioId: "<unknown>",
            field: "id",
            message: example.message,
          },
        });
      }
    });
  });

  test("submission envelopes and Scenario invariants are decoded before acceptance", async () => {
    const directory = await makeTemporaryDirectory();
    const validScenario = {
      id: "account-loads",
      goal: "Show the account",
      preconditions: [] as readonly string[],
      mutates: false,
      script: "async () => {}",
    };
    const examples: readonly {
      readonly payload: unknown;
      readonly maxScenarios: number;
      readonly scenarioId: string;
      readonly field: string;
      readonly message: string;
    }[] = [
      {
        payload: { schemaVersion: 2, scenarios: [] },
        maxScenarios: 1,
        scenarioId: "<submission>",
        field: "schemaVersion",
        message: "generate-plan submission requires schemaVersion 1",
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: "not an array",
        },
        maxScenarios: 1,
        scenarioId: "<submission>",
        field: "scenarios",
        message: "generate-plan submission requires a scenarios array",
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [],
        },
        maxScenarios: 1,
        scenarioId: "<unknown>",
        field: "id",
        message: "A generate-plan submission requires a Scenario",
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [
            { ...validScenario, id: "first" },
            { ...validScenario, id: "second" },
          ],
        },
        maxScenarios: 1,
        scenarioId: "<submission>",
        field: "scenarios",
        message: "generate-plan submission exceeds the Scenario limit of 1",
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [validScenario, validScenario],
        },
        maxScenarios: 2,
        scenarioId: validScenario.id,
        field: "id",
        message: `Scenario ${validScenario.id} has a duplicate required field id`,
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [{ ...validScenario, goal: 42 }],
        },
        maxScenarios: 1,
        scenarioId: validScenario.id,
        field: "goal",
        message: `Scenario ${validScenario.id} has invalid required field goal`,
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [
            {
              ...validScenario,
              preconditions: "already signed in",
            },
          ],
        },
        maxScenarios: 1,
        scenarioId: validScenario.id,
        field: "preconditions",
        message: `Scenario ${validScenario.id} has invalid required field preconditions`,
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [
            {
              ...validScenario,
              preconditions: ["signed in", 42],
            },
          ],
        },
        maxScenarios: 1,
        scenarioId: validScenario.id,
        field: "preconditions",
        message: `Scenario ${validScenario.id} has invalid required field preconditions`,
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [{ ...validScenario, mutates: "no" }],
        },
        maxScenarios: 1,
        scenarioId: validScenario.id,
        field: "mutates",
        message: `Scenario ${validScenario.id} has invalid required field mutates`,
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [{ ...validScenario, script: 42 }],
        },
        maxScenarios: 1,
        scenarioId: validScenario.id,
        field: "script",
        message: `Scenario ${validScenario.id} has invalid required field script`,
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [{ ...validScenario, mutates: true }],
        },
        maxScenarios: 1,
        scenarioId: validScenario.id,
        field: "mutates",
        message: `Scenario ${validScenario.id} requires mutation permission`,
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [{ ...validScenario, script: "42" }],
        },
        maxScenarios: 1,
        scenarioId: validScenario.id,
        field: "script",
        message: `Scenario ${validScenario.id} has invalid required field script`,
      },
    ];

    await withHarnessBaseUrl(async (baseUrl) => {
      for (const [index, example] of examples.entries()) {
        const runId = RunId(`run-envelope-${index}`);
        const databasePath = join(directory, `state-${index}.db`);
        const rejected = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath,
                changeInspector: {
                  inspect: () => Effect.succeed([]),
                },
                scenarioRuntime: makeDeterministicScenarioRuntime(),
                runReporter: {
                  writeReport: () => Effect.void,
                },
                planLimits: {
                  maxScenarios: example.maxScenarios,
                  scenarioTimeoutMs: 30_000,
                  activeWorkBudgetMs: 300_000,
                },
              });
              const started = yield* engine.dispatch(runId, {
                type: "start",
                baseUrl,
              });
              const result = yield* Effect.either(
                engine.dispatch(runId, {
                  type: "submitJob",
                  jobId: started.pendingJob.id,
                  payload: example.payload,
                })
              );
              return {
                result,
                status: yield* engine.getStatus(runId),
                pendingJob: yield* engine.getPendingJob(runId),
              };
            })
          )
        );

        expect(rejected).toMatchObject({
          result: {
            _tag: "Left",
            left: {
              _tag: "PlanValidationError",
              scenarioId: example.scenarioId,
              field: example.field,
              message: example.message,
            },
          },
          status: {
            runId,
            phase: "awaitingAgent",
          },
          pendingJob: {
            id: `${runId}:generate-plan:1`,
          },
        });
      }
    });
  });

  test("a completed Job replay is idempotent and rejects a different submission", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-idempotent-submit");
    const payload = {
      schemaVersion: 1 as const,
      scenarios: [
        {
          id: "account-loads",
          goal: "Show the account",
          preconditions: [],
          mutates: false,
          script: "async () => {}",
        },
      ],
    };

    await withHarnessBaseUrl(async (baseUrl) => {
      const first = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createNoChangeWorkflowEngine(databasePath);
            const started = yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
            const result = yield* engine.dispatch(runId, {
              type: "submitJob",
              jobId: started.pendingJob.id,
              payload,
            });
            return { jobId: started.pendingJob.id, result };
          })
        )
      );

      const replayed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createNoChangeWorkflowEngine(databasePath);
            const same = yield* engine.dispatch(runId, {
              type: "submitJob",
              jobId: first.jobId,
              payload: {
                scenarios: [
                  {
                    script: payload.scenarios[0]!.script,
                    mutates: payload.scenarios[0]!.mutates,
                    preconditions: payload.scenarios[0]!.preconditions,
                    goal: payload.scenarios[0]!.goal,
                    id: payload.scenarios[0]!.id,
                  },
                ],
                schemaVersion: payload.schemaVersion,
              },
            });
            const conflict = yield* Effect.either(
              engine.dispatch(runId, {
                type: "submitJob",
                jobId: first.jobId,
                payload: {
                  ...payload,
                  scenarios: [
                    {
                      ...payload.scenarios[0],
                      goal: "A different goal",
                    },
                  ],
                },
              })
            );
            return {
              same,
              conflict,
              status: yield* engine.getStatus(runId),
              pendingJob: yield* engine.getPendingJob(runId),
            };
          })
        )
      );

      expect(replayed.same).toEqual(first.result);
      expect(replayed).toMatchObject({
        conflict: {
          _tag: "Left",
          left: {
            _tag: "JobSubmissionConflictError",
            jobId: first.jobId,
          },
        },
        status: {
          runId,
          phase: "awaitingAgent",
        },
        pendingJob: { type: "classify-findings" },
      });
    });
  });

  test("the WorkflowEngine enforces the Scenario timeout at its host-neutral seam", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-scenario-timeout");

    await withHarnessBaseUrl(async (baseUrl) => {
      const timedOut = await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath,
                changeInspector: {
                  inspect: () => Effect.succeed([]),
                },
                scenarioRuntime: {
                  reconcile: () => Effect.void,
                  execute: () => Effect.never,
                },
                runReporter: {
                  writeReport: () => Effect.void,
                },
                planLimits: {
                  maxScenarios: 1,
                  scenarioTimeoutMs: 5,
                  activeWorkBudgetMs: 100,
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
                  scenarios: [
                    {
                      id: "never-finishes",
                      goal: "Exercise the timeout",
                      preconditions: [],
                      mutates: false,
                      script: "async () => {}",
                    },
                  ],
                },
              });
            })
          )
        )
      );

      expect(timedOut).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "ScenarioRuntimeError",
          operation: "execute Scenario",
        },
      });
    });
  });

  test.each([0, 1000])(
    "a Run budget binding before the Scenario timeout reports budget exhaustion with %ims overhead allowance",
    async (executionOverheadMs) => {
      const directory = await makeTemporaryDirectory();
      const databasePath = join(directory, "state.db");
      const runId = RunId("run-active-budget-timeout");

      await withHarnessBaseUrl(async (baseUrl) => {
        const exhausted = await Effect.runPromise(
          Effect.either(
            Effect.scoped(
              Effect.gen(function* () {
                const engine = yield* createWorkflowEngine({
                  databasePath,
                  changeInspector: {
                    inspect: () => Effect.succeed([]),
                  },
                  scenarioRuntime: {
                    executionOverheadMs,
                    reconcile: () => Effect.void,
                    execute: () => Effect.never,
                  },
                  runReporter: {
                    writeReport: () => Effect.void,
                  },
                  planLimits: {
                    maxScenarios: 1,
                    scenarioTimeoutMs: 1_000,
                    activeWorkBudgetMs: 100,
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
                    scenarios: [
                      {
                        id: "never-finishes",
                        goal: "Exhaust the Run budget",
                        preconditions: [],
                        mutates: false,
                        script: "async () => {}",
                      },
                    ],
                  },
                });
              })
            )
          )
        );

        expect(exhausted).toMatchObject({
          _tag: "Left",
          left: {
            _tag: "RunBudgetExceededError",
            runId,
          },
        });
        const charged = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const store = yield* openSqliteRunStore(databasePath);
              return yield* store.getActiveWorkMs(runId);
            })
          )
        );
        expect(charged).toBeLessThan(300);
      });
    }
  );

  test("an exhausted Run can report incomplete coverage and release the worktree", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("exhausted-report");
    await withHarnessBaseUrl(async (baseUrl) => {
      const submission = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: { inspect: () => Effect.succeed([]) },
              scenarioRuntime: {
                reconcile: () => Effect.void,
                execute: () => Effect.never,
              },
              planLimits: {
                maxScenarios: 2,
                scenarioTimeoutMs: 1000,
                activeWorkBudgetMs: 100,
              },
            });
            const started = yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
            const submission = {
              type: "submitJob",
              jobId: started.pendingJob.id,
              payload: {
                schemaVersion: 1,
                scenarios: ["interrupted", "unexecuted"].map((id) => ({
                  id,
                  goal: "Exercise exhaustion recovery",
                  preconditions: [],
                  mutates: false,
                  script: "async () => {}",
                })),
              },
            } as const;
            expect(
              yield* Effect.either(engine.dispatch(runId, submission))
            ).toMatchObject({
              _tag: "Left",
              left: { _tag: "RunBudgetExceededError" },
            });
            return submission;
          })
        )
      );
      const completed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: { inspect: () => Effect.succeed([]) },
            });
            const recovered = yield* engine.dispatch(runId, submission);
            if (recovered.phase !== "awaitingAgent")
              throw new Error("Expected review");
            const review = {
              type: "submitJob",
              jobId: recovered.pendingJob.id,
              payload: {
                schemaVersion: 1,
                resolution: "report-only",
                classifications: recovered.pendingJob.payload.findings.map(
                  (finding) => ({
                    findingId: finding.id,
                    classification: "infra-issue",
                    reasoning:
                      "The Run exhausted its budget before coverage completed.",
                    coverageComplete: false,
                    reviewedEvidence: [],
                  })
                ),
              },
            } as const;
            const result = yield* engine.dispatch(runId, review);
            expect(yield* engine.dispatch(runId, review)).toEqual(result);
            expect(yield* engine.getStatus(runId)).toMatchObject(result);
            yield* engine.dispatch(RunId("after-exhaustion"), {
              type: "start",
              baseUrl,
            });
            return result;
          })
        )
      );
      expect(completed).toMatchObject({
        phase: "completed",
        outcome: "inconclusive",
        coverageIncomplete: true,
        incompleteScenarios: expect.arrayContaining([
          "interrupted",
          "unexecuted",
        ]),
      });
      expect(
        JSON.parse(
          await readFile(join(directory, "runs", runId, "report.json"), "utf8")
        )
      ).toEqual(completed);
    });
  });

  test("terminal reporting has a separate bounded allowance and remains retryable", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    await withHarnessBaseUrl(async (baseUrl) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const enteredReport = yield* Deferred.make<void>();
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: { inspect: () => Effect.succeed([]) },
              scenarioRuntime: makeDeterministicScenarioRuntime(),
              runReporter: {
                writeReport: () =>
                  Deferred.succeed(enteredReport, undefined).pipe(
                    Effect.zipRight(Effect.never)
                  ),
              },
              planLimits: {
                maxScenarios: 1,
                scenarioTimeoutMs: 100,
                activeWorkBudgetMs: 100,
              },
            });
            const runId = RunId("bounded-report");
            const start = yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
            const batch = yield* engine.dispatch(runId, {
              type: "submitJob",
              jobId: start.pendingJob.id,
              payload: {
                schemaVersion: 1,
                scenarios: [
                  {
                    id: "account",
                    goal: "Account renders",
                    preconditions: [],
                    mutates: false,
                    script: "async () => {}",
                  },
                ],
              },
            });
            if (batch.phase !== "awaitingAgent")
              throw new Error("Expected review");
            const review = {
              type: "submitJob",
              jobId: batch.pendingJob.id,
              payload: {
                schemaVersion: 1,
                resolution: "report-only",
                classifications: batch.pendingJob.payload.findings.map(
                  (finding) => ({
                    findingId: finding.id,
                    classification: "verified-success",
                    reasoning: "The rendered page supports the goal.",
                    coverageComplete: true,
                    reviewedEvidence: ["final.png", "final.aria.yaml"],
                  })
                ),
              },
            } as const;
            const reporting = yield* Effect.forkScoped(
              Effect.either(engine.dispatch(runId, review))
            );
            yield* Deferred.await(enteredReport);
            yield* TestClock.adjust("29 seconds");
            expect(yield* Fiber.poll(reporting)).toMatchObject({
              _tag: "None",
            });
            yield* TestClock.adjust("2 seconds");
            expect(yield* Fiber.poll(reporting)).toMatchObject({
              _tag: "Some",
              value: {
                _tag: "Success",
                value: { _tag: "Left", left: { _tag: "RunReportError" } },
              },
            });
            expect(yield* engine.getStatus(runId)).toMatchObject({
              phase: "reporting",
            });
            const restarted = yield* createWorkflowEngine({
              databasePath,
              changeInspector: { inspect: () => Effect.succeed([]) },
              scenarioRuntime: {
                reconcile: () => Effect.void,
                execute: () =>
                  Effect.die("Reporting recovery must not execute Scenarios"),
              },
            });
            expect(yield* restarted.dispatch(runId, review)).toMatchObject({
              phase: "completed",
              outcome: "passed",
            });
          })
        ).pipe(Effect.provide(TestContext.TestContext))
      );
    });
  });

  test("slow scoped cleanup preserves completed Attempts and finishes before the next Scenario", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const events: string[] = [];
    await withHarnessBaseUrl(async (baseUrl) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: { inspect: () => Effect.succeed([]) },
              scenarioRuntime: {
                reconcile: () => Effect.void,
                execute: (attempt, environment) =>
                  Effect.gen(function* () {
                    events.push(`start ${attempt.scenario.id}`);
                    yield* Effect.addFinalizer(() =>
                      Effect.sleep(400).pipe(
                        Effect.andThen(() => {
                          events.push(`cleaned ${attempt.scenario.id}`);
                        })
                      )
                    );
                    return yield* makeDeterministicScenarioRuntime().execute(
                      attempt,
                      environment
                    );
                  }),
              },
              planLimits: {
                maxScenarios: 2,
                scenarioTimeoutMs: 100,
                activeWorkBudgetMs: 300,
              },
            });
            const runId = RunId("slow-cleanup");
            const start = yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
            const submission = {
              type: "submitJob",
              jobId: start.pendingJob.id,
              payload: {
                schemaVersion: 1,
                scenarios: ["first", "second"].map((id) => ({
                  id,
                  goal: "Keep completed evidence",
                  preconditions: [],
                  mutates: false,
                  script: "async () => {}",
                })),
              },
            } as const;
            const result = yield* engine.dispatch(runId, submission);
            expect(result).toMatchObject({
              phase: "awaitingAgent",
              pendingJob: {
                payload: {
                  findings: [
                    {
                      scenarioId: "first",
                      mechanicalStatus: "passed",
                      evidenceBundle: {
                        files: ["result.json", "final.png", "final.aria.yaml"],
                      },
                    },
                    { scenarioId: "second", mechanicalStatus: "passed" },
                  ],
                },
              },
            });
            expect(events).toEqual([
              "start first",
              "cleaned first",
              "start second",
              "cleaned second",
            ]);
            expect(yield* engine.dispatch(runId, submission)).toEqual(result);
          })
        )
      );
    });
  });

  test("timed-out Scenario cleanup is not charged as active work", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-timeout-cleanup-accounting");

    await withHarnessBaseUrl(async (baseUrl) => {
      const afterStart = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: {
                inspect: () => Effect.succeed([]),
              },
              scenarioRuntime: {
                reconcile: () => Effect.void,
                execute: (_attempt, environment) =>
                  Effect.acquireUseRelease(
                    Effect.void,
                    () =>
                      Effect.never.pipe(
                        Effect.ensuring(
                          Effect.sync(() => {
                            environment.checkpointActiveWork(3);
                          })
                        )
                      ),
                    () => Effect.sleep(150)
                  ),
              },
              runReporter: {
                writeReport: () => Effect.void,
              },
              planLimits: {
                maxScenarios: 1,
                scenarioTimeoutMs: 5,
                activeWorkBudgetMs: 1_000,
              },
            });
            const started = yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
            const store = yield* openSqliteRunStore(databasePath);
            const activeWorkMs = yield* store.getActiveWorkMs(runId);
            return { started, activeWorkMs };
          })
        )
      );

      await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath,
                changeInspector: {
                  inspect: () => Effect.succeed([]),
                },
                scenarioRuntime: {
                  reconcile: () => Effect.void,
                  execute: (_attempt, environment) =>
                    Effect.acquireUseRelease(
                      Effect.void,
                      () =>
                        Effect.never.pipe(
                          Effect.ensuring(
                            Effect.sync(() => {
                              environment.checkpointActiveWork(3);
                            })
                          )
                        ),
                      () => Effect.sleep(150)
                    ),
                },
                runReporter: {
                  writeReport: () => Effect.void,
                },
              });
              return yield* engine.dispatch(runId, {
                type: "submitJob",
                jobId: afterStart.started.pendingJob.id,
                payload: {
                  schemaVersion: 1,
                  scenarios: [
                    {
                      id: "times-out",
                      goal: "Time out before slow cleanup",
                      preconditions: [],
                      mutates: false,
                      script: "async () => {}",
                    },
                  ],
                },
              });
            })
          )
        )
      );

      const recorded = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openSqliteRunStore(databasePath);
            return yield* store.getActiveWorkMs(runId);
          })
        )
      );
      expect(recorded - afterStart.activeWorkMs).toBeLessThan(100);
    });
  });

  test("a restarted Turn enforces the Plan limits persisted with its Run", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-durable-limits");

    await withHarnessBaseUrl(async (baseUrl) => {
      const started = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: {
                inspect: () => Effect.succeed([]),
              },
              planLimits: {
                maxScenarios: 1,
                scenarioTimeoutMs: 50,
                activeWorkBudgetMs: 500,
              },
            });
            return yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
          })
        )
      );
      const rejected = await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath,
                changeInspector: {
                  inspect: () => Effect.succeed([]),
                },
                planLimits: {
                  maxScenarios: 20,
                  scenarioTimeoutMs: 30_000,
                  activeWorkBudgetMs: 300_000,
                },
              });
              return yield* engine.dispatch(runId, {
                type: "submitJob",
                jobId: started.pendingJob.id,
                payload: {
                  schemaVersion: 1,
                  scenarios: ["first", "second"],
                },
              });
            })
          )
        )
      );

      expect(rejected).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "PlanValidationError",
          field: "scenarios",
          message: "generate-plan submission exceeds the Scenario limit of 1",
        },
      });
    });
  });

  test("a new process takes over a stale inspection Turn and reruns it", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("inspection-recovery");

    await withHarnessBaseUrl(async (baseUrl) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openSqliteRunStore(databasePath);
            const staleLease = yield* store.acquireTurn(runId, {
              processId: 101,
              processIncarnation: {
                bootId: "boot-001",
                startTicks: "100",
              },
              ownershipToken: "stale-turn-001",
            });
            yield* store.startInspection(staleLease, runId, baseUrl, "rerun", {
              maxScenarios: 20,
              scenarioTimeoutMs: 30_000,
              activeWorkBudgetMs: 300_000,
            });
          })
        )
      );
      replaceTurnIncarnationWithLegacyTimestamp(databasePath);

      const recovered = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: {
                inspect: () =>
                  Effect.succeed([
                    {
                      kind: "modified",
                      path: "src/account.tsx",
                    },
                  ]),
              },
              processIdentity: {
                isRunning: () => Effect.succeed(false),
              },
              turnOwnerFactory: () => ({
                processId: 202,
                processIncarnation: {
                  bootId: "boot-001",
                  startTicks: "200",
                },
                ownershipToken: "replacement-turn-001",
              }),
            });
            const dispatch = yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
            return {
              dispatch,
              pendingJob: yield* engine.getPendingJob(runId),
              status: yield* engine.getStatus(runId),
            };
          })
        )
      );

      expect(recovered).toMatchObject({
        dispatch: {
          phase: "awaitingAgent",
          pendingJob: {
            schemaVersion: 1,
            type: "generate-plan",
            payload: {
              changes: [
                {
                  kind: "modified",
                  path: "src/account.tsx",
                },
              ],
            },
          },
        },
        pendingJob: {
          schemaVersion: 1,
          type: "generate-plan",
          payload: {
            changes: [
              {
                kind: "modified",
                path: "src/account.tsx",
              },
            ],
          },
        },
        status: {
          runId: "inspection-recovery",
          phase: "awaitingAgent",
        },
      });
    });
  });

  test("a restarted engine reruns interrupted deterministic inspection", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-recovery-001");

    await withHarnessBaseUrl(async (baseUrl) => {
      const interrupted = await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath,
                changeInspector: {
                  inspect: () =>
                    Effect.fail(
                      new ChangeInspectionError(
                        "inspection process interrupted"
                      )
                    ),
                },
              });
              return yield* engine.dispatch(runId, {
                type: "start",
                baseUrl,
              });
            })
          )
        )
      );

      expect(interrupted._tag).toBe("Left");
      if (interrupted._tag === "Left") {
        expect(interrupted.left).toBeInstanceOf(ChangeInspectionError);
      }

      const recovered = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: {
                inspect: () =>
                  Effect.succeed([
                    {
                      kind: "modified",
                      path: "src/dashboard.tsx",
                    },
                  ]),
              },
            });
            return yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
          })
        )
      );

      expect(recovered).toMatchObject({
        phase: "awaitingAgent",
        pendingJob: {
          type: "generate-plan",
          payload: {
            changes: [
              {
                kind: "modified",
                path: "src/dashboard.tsx",
              },
            ],
          },
        },
      });
    });
  });

  test("a Turn lock rejects concurrent mutation before one-active-Run enforcement", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    let releaseInspection:
      | ((changes: readonly { kind: string; path: string }[]) => void)
      | undefined;
    let markInspectionStarted: (() => void) | undefined;
    const inspectionStarted = new Promise<void>((resolve) => {
      markInspectionStarted = resolve;
    });

    await withHarnessBaseUrl(async (baseUrl) => {
      const firstDispatch = Effect.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: {
                inspect: () =>
                  Effect.async((resume) => {
                    releaseInspection = (changes) => {
                      resume(Effect.succeed(changes));
                    };
                    markInspectionStarted?.();
                  }),
              },
            });
            return yield* engine.dispatch(RunId("run-lock-owner"), {
              type: "start",
              baseUrl,
            });
          })
        )
      );

      try {
        await inspectionStarted;
        replaceTurnIncarnationWithLegacyTimestamp(databasePath);

        const concurrent = await Effect.runPromise(
          Effect.either(
            Effect.scoped(
              Effect.gen(function* () {
                const engine =
                  yield* createNoChangeWorkflowEngine(databasePath);
                return yield* engine.dispatch(RunId("run-lock-contender"), {
                  type: "start",
                  baseUrl,
                });
              })
            )
          )
        );

        expect(concurrent._tag).toBe("Left");
        if (concurrent._tag === "Left") {
          expect(concurrent.left).toBeInstanceOf(RunBusyError);
          expect(concurrent.left).toMatchObject({
            owningRunId: "run-lock-owner",
          });
        }

        const observation = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createNoChangeWorkflowEngine(
                databasePath,
                true
              );
              return {
                status: yield* engine.getStatus(RunId("run-lock-owner")),
                job: yield* engine.getPendingJob(RunId("run-lock-owner")),
              };
            })
          )
        );
        expect(observation).toEqual({
          status: {
            runId: "run-lock-owner",
            phase: "inspectingChanges",
          },
          job: null,
        });

        const release = releaseInspection;
        releaseInspection = undefined;
        release?.([{ kind: "modified", path: "src/dashboard.tsx" }]);
        const completed = await Effect.runPromise(Fiber.join(firstDispatch));
        expect(completed).toMatchObject({
          phase: "awaitingAgent",
          pendingJob: {
            schemaVersion: 1,
            type: "generate-plan",
          },
        });

        const afterRelease = await Effect.runPromise(
          Effect.either(
            Effect.scoped(
              Effect.gen(function* () {
                const engine =
                  yield* createNoChangeWorkflowEngine(databasePath);
                return yield* engine.dispatch(RunId("run-after-release"), {
                  type: "start",
                  baseUrl,
                });
              })
            )
          )
        );

        expect(afterRelease._tag).toBe("Left");
        if (afterRelease._tag === "Left") {
          expect(afterRelease.left).toBeInstanceOf(ActiveRunExistsError);
        }
      } finally {
        const release = releaseInspection;
        releaseInspection = undefined;
        release?.([]);
        await Effect.runPromise(Fiber.interrupt(firstDispatch));
      }
    });
  });

  test("a superseded Turn lease cannot checkpoint automatic work", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");

    await withHarnessBaseUrl(async (baseUrl) => {
      const checkpoint = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openSqliteRunStore(databasePath);
            const firstLease = yield* store.acquireTurn(
              RunId("run-fenced-owner"),
              {
                processId: 101,
                processIncarnation: {
                  bootId: "boot-001",
                  startTicks: "100",
                },
                ownershipToken: "lease-001",
              }
            );
            yield* store.releaseTurn(firstLease);
            const currentLease = yield* store.acquireTurn(
              RunId("run-fenced-owner"),
              {
                processId: 202,
                processIncarnation: {
                  bootId: "boot-001",
                  startTicks: "200",
                },
                ownershipToken: "lease-002",
              }
            );
            const result = yield* Effect.either(
              store.startInspection(
                firstLease,
                RunId("run-fenced-owner"),
                baseUrl,
                "rerun",
                {
                  maxScenarios: 20,
                  scenarioTimeoutMs: 30_000,
                  activeWorkBudgetMs: 300_000,
                }
              )
            );
            yield* store.releaseTurn(currentLease);
            return result;
          })
        )
      );

      expect(checkpoint._tag).toBe("Left");
      if (checkpoint._tag === "Left") {
        expect(checkpoint.left).toBeInstanceOf(TurnOwnershipLostError);
      }
    });
  });

  test("an invalid Event reports the phase and allowed Events", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-invalid-transition");
    const changeInspector: ChangeInspector = {
      inspect: () => Effect.succeed([]),
    };

    await withHarnessBaseUrl(async (baseUrl) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector,
            });
            yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
          })
        )
      );

      const repeatedStart = await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath,
                changeInspector,
              });
              return yield* engine.dispatch(runId, {
                type: "start",
                baseUrl,
              });
            })
          )
        )
      );

      expect(repeatedStart._tag).toBe("Left");
      if (repeatedStart._tag === "Left") {
        expect(repeatedStart.left).toBeInstanceOf(InvalidTransitionError);
        expect(repeatedStart.left).toMatchObject({
          phase: "awaitingAgent",
          event: "start",
          allowedEvents: ["findingsClassified", "submitJob", "abandon"],
        });
      }
    });
  });

  test("abandon makes a Run terminal and removes its pending Job", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-abandoned");

    await withHarnessBaseUrl(async (baseUrl) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createNoChangeWorkflowEngine(databasePath);
            yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
            const abandoned = yield* engine.dispatch(runId, {
              type: "abandon",
              reason: "superseded",
            });
            return {
              abandoned,
              status: yield* engine.getStatus(runId),
              pendingJob: yield* engine.getPendingJob(runId),
              repeated: yield* Effect.either(
                engine.dispatch(runId, {
                  type: "abandon",
                  reason: "must not replace the original reason",
                })
              ),
            };
          })
        )
      );

      expect(result).toMatchObject({
        abandoned: {
          runId,
          phase: "abandoned",
          reason: "superseded",
        },
        status: {
          runId,
          phase: "abandoned",
          reason: "superseded",
        },
        pendingJob: null,
      });
      expect(result.repeated._tag).toBe("Left");
      if (result.repeated._tag === "Left") {
        expect(result.repeated.left).toBeInstanceOf(InvalidTransitionError);
      }
    });
  });

  test("abandon reports a missing Run through the WorkflowEngine seam", async () => {
    const directory = await makeTemporaryDirectory();
    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createNoChangeWorkflowEngine(
              join(directory, "state.db")
            );
            return yield* engine.dispatch(RunId("missing-run"), {
              type: "abandon",
              reason: "superseded",
            });
          })
        )
      )
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(RunNotFoundError);
    }
  });

  test("each dispatch allocates fresh Turn ownership", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-unique-turn-owner");
    const ownershipTokens: string[] = [];

    await withHarnessBaseUrl(async (baseUrl) => {
      const repeatedStart = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector: {
                inspect: () => Effect.succeed([]),
              },
              turnOwnerFactory: () => {
                const ownershipToken = `turn-${ownershipTokens.length + 1}`;
                ownershipTokens.push(ownershipToken);
                return {
                  processId: 101,
                  processIncarnation: {
                    bootId: "boot-001",
                    startTicks: "100",
                  },
                  ownershipToken,
                };
              },
            });
            yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
            return yield* Effect.either(
              engine.dispatch(runId, {
                type: "start",
                baseUrl,
              })
            );
          })
        )
      );

      expect(repeatedStart._tag).toBe("Left");
      if (repeatedStart._tag === "Left") {
        expect(repeatedStart.left).toBeInstanceOf(InvalidTransitionError);
      }
      expect(ownershipTokens).toEqual(["turn-1", "turn-2"]);
    });
  });
});
