import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
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
  use: (baseUrl: URL) => Promise<Result>,
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

const createNoChangeWorkflowEngine = (
  databasePath: string,
  readOnly = false,
) =>
  createWorkflowEngine({
    databasePath,
    changeInspector: {
      inspect: () => Effect.succeed([]),
    },
    readOnly,
    scenarioRuntime: makeDeterministicScenarioRuntime(),
    runReporter: {
      writePassingReport: () => Effect.void,
    },
  });

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true }),
    ),
  );
});

describe("WorkflowEngine durable generate-plan handoff", () => {
  test("a Run with no durable state has no pending Job", async () => {
    const directory = await makeTemporaryDirectory();
    const pendingJob = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createNoChangeWorkflowEngine(
            join(directory, "state.db"),
          );
          return yield* engine.getPendingJob(RunId("missing-run"));
        }),
      ),
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
          }),
        ),
      ),
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
          }),
        ),
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
          }),
        ),
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
            const engine =
              yield* createNoChangeWorkflowEngine(databasePath);
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
              }),
            );
            return { rejected, pendingJob: started.pendingJob };
          }),
        ),
      );

      expect(result.rejected).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "PlanValidationError",
          scenarioId: "checkout-submits",
          field: "goal",
          message:
            "Scenario checkout-submits is missing required field goal",
        },
      });

      const restarted = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine =
              yield* createNoChangeWorkflowEngine(databasePath);
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
                        preconditions: [],
                        mutates: false,
                        script:
                          "async ({ page }) => { await page.goto('/dashboard'); }",
                      },
                    ],
                  },
                }),
              ),
            };
          }),
        ),
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
            phase: "completed",
            outcome: "passed",
            attempts: [
              {
                scenarioId: "dashboard-loads",
                attemptNumber: 1,
                scriptVersion: 0,
                status: "passed",
              },
            ],
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
    ];

    await withHarnessBaseUrl(async (baseUrl) => {
      for (const [index, example] of examples.entries()) {
        const runId = RunId(`run-malformed-plan-${index}`);
        const rejected = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createNoChangeWorkflowEngine(
                join(directory, `state-${index}.db`),
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
                }),
              );
            }),
          ),
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

  test("submission envelopes and Scenario count limits are decoded before acceptance", async () => {
    const directory = await makeTemporaryDirectory();
    const examples = [
      {
        payload: { schemaVersion: 2, scenarios: [] },
        field: "schemaVersion",
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: "not an array",
        },
        field: "scenarios",
      },
      {
        payload: {
          schemaVersion: 1,
          scenarios: [
            {
              id: "first",
              goal: "First Scenario",
              preconditions: [],
              mutates: false,
              script: "async () => {}",
            },
            {
              id: "second",
              goal: "Second Scenario",
              preconditions: [],
              mutates: false,
              script: "async () => {}",
            },
          ],
        },
        field: "scenarios",
      },
    ] as const;

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
                scenarioRuntime:
                  makeDeterministicScenarioRuntime(),
                runReporter: {
                  writePassingReport: () => Effect.void,
                },
                planLimits: {
                  maxScenarios: 1,
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
                }),
              );
              return {
                result,
                status: yield* engine.getStatus(runId),
                pendingJob: yield* engine.getPendingJob(runId),
              };
            }),
          ),
        );

        expect(rejected).toMatchObject({
          result: {
            _tag: "Left",
            left: {
              _tag: "PlanValidationError",
              field: example.field,
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
            const engine =
              yield* createNoChangeWorkflowEngine(databasePath);
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
          }),
        ),
      );

      const replayed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine =
              yield* createNoChangeWorkflowEngine(databasePath);
            const same = yield* engine.dispatch(runId, {
              type: "submitJob",
              jobId: first.jobId,
              payload,
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
              }),
            );
            return {
              same,
              conflict,
              status: yield* engine.getStatus(runId),
              pendingJob: yield* engine.getPendingJob(runId),
            };
          }),
        ),
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
          phase: "completed",
          outcome: "passed",
        },
        pendingJob: null,
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
                  execute: () => Effect.never,
                },
                runReporter: {
                  writePassingReport: () => Effect.void,
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
            }),
          ),
        ),
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
                        "inspection process interrupted",
                      ),
                    ),
                },
              });
              return yield* engine.dispatch(runId, {
                type: "start",
                baseUrl,
              });
            }),
          ),
        ),
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
          }),
        ),
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
          }),
        ),
      );

      try {
        await inspectionStarted;

        const concurrent = await Effect.runPromise(
          Effect.either(
            Effect.scoped(
              Effect.gen(function* () {
                const engine =
                  yield* createNoChangeWorkflowEngine(databasePath);
                return yield* engine.dispatch(
                  RunId("run-lock-contender"),
                  {
                    type: "start",
                    baseUrl,
                  },
                );
              }),
            ),
          ),
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
              const engine =
                yield* createNoChangeWorkflowEngine(
                  databasePath,
                  true,
                );
              return {
                status: yield* engine.getStatus(
                  RunId("run-lock-owner"),
                ),
                job: yield* engine.getPendingJob(
                  RunId("run-lock-owner"),
                ),
              };
            }),
          ),
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
        release?.([
          { kind: "modified", path: "src/dashboard.tsx" },
        ]);
        const completed = await Effect.runPromise(
          Fiber.join(firstDispatch),
        );
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
                return yield* engine.dispatch(
                  RunId("run-after-release"),
                  {
                    type: "start",
                    baseUrl,
                  },
                );
              }),
            ),
          ),
        );

        expect(afterRelease._tag).toBe("Left");
        if (afterRelease._tag === "Left") {
          expect(afterRelease.left).toBeInstanceOf(
            ActiveRunExistsError,
          );
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
                processStartedAt: "2026-07-23T20:00:00.000Z",
                ownershipToken: "lease-001",
              },
            );
            yield* store.releaseTurn(firstLease);
            const currentLease = yield* store.acquireTurn(
              RunId("run-fenced-owner"),
              {
                processId: 202,
                processStartedAt: "2026-07-23T20:01:00.000Z",
                ownershipToken: "lease-002",
              },
            );
            const result = yield* Effect.either(
              store.startInspection(
                firstLease,
                RunId("run-fenced-owner"),
                baseUrl,
                "rerun",
              ),
            );
            yield* store.releaseTurn(currentLease);
            return result;
          }),
        ),
      );

      expect(checkpoint._tag).toBe("Left");
      if (checkpoint._tag === "Left") {
        expect(checkpoint.left).toBeInstanceOf(
          TurnOwnershipLostError,
        );
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
          }),
        ),
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
            }),
          ),
        ),
      );

      expect(repeatedStart._tag).toBe("Left");
      if (repeatedStart._tag === "Left") {
        expect(repeatedStart.left).toBeInstanceOf(
          InvalidTransitionError,
        );
        expect(repeatedStart.left).toMatchObject({
          phase: "awaitingAgent",
          event: "start",
          allowedEvents: ["submitJob", "abandon"],
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
            const engine =
              yield* createNoChangeWorkflowEngine(databasePath);
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
                }),
              ),
            };
          }),
        ),
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
        expect(result.repeated.left).toBeInstanceOf(
          InvalidTransitionError,
        );
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
              join(directory, "state.db"),
            );
            return yield* engine.dispatch(RunId("missing-run"), {
              type: "abandon",
              reason: "superseded",
            });
          }),
        ),
      ),
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
                  processStartedAt: "2026-07-23T20:00:00.000Z",
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
              }),
            );
          }),
        ),
      );

      expect(repeatedStart._tag).toBe("Left");
      if (repeatedStart._tag === "Left") {
        expect(repeatedStart.left).toBeInstanceOf(
          InvalidTransitionError,
        );
      }
      expect(ownershipTokens).toEqual(["turn-1", "turn-2"]);
    });
  });
});
