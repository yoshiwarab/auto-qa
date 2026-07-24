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
  RunId,
  RunBusyError,
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
          const engine = yield* createWorkflowEngine({
            databasePath: join(directory, "state.db"),
            changeInspector: {
              inspect: () => Effect.succeed([]),
            },
          });
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
      | ((changes: readonly [{ kind: string; path: string }]) => void)
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

      await inspectionStarted;

      const concurrent = await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath,
                changeInspector: {
                  inspect: () => Effect.succeed([]),
                },
              });
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
      }

      releaseInspection?.([
        { kind: "modified", path: "src/dashboard.tsx" },
      ]);
      await Effect.runPromise(Fiber.join(firstDispatch));

      const afterRelease = await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath,
                changeInspector: {
                  inspect: () => Effect.succeed([]),
                },
              });
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
          allowedEvents: [],
        });
      }
    });
  });
});
