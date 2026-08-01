import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { expect } from "vitest";
import {
  RunBusyError,
  RunId,
  createWorkflowEngine,
  makeDeterministicScenarioRuntime,
  type DispatchResult,
  type WorkflowError,
} from "../src/index.js";
import type { TurnLease } from "../src/runStore.js";
import { openSqliteRunStore } from "../src/sqliteRunStore.js";
import {
  exampleValue,
  type FeatureBindings,
  type StepHandler,
} from "./runtime.js";
import { makeTargetApplicationHarness } from "./targetApplicationHarness.js";

type World = {
  readonly databasePath: string;
  readonly baseUrl: URL;
  readonly inspectionStarted: Promise<void>;
  readonly signaledProcesses: number[];
  markInspectionStarted: () => void;
  firstOwnershipToken?: string;
  firstLease?: TurnLease;
  secondOwnershipToken?: string;
  recordedOwnerIsCurrent?: boolean;
  reportedChanges?: readonly {
    readonly kind: "modified";
    readonly path: string;
  }[];
  releaseInspection?: () => void;
  firstDispatch?: Fiber.RuntimeFiber<DispatchResult, WorkflowError>;
  secondDispatch?: DispatchResult;
  secondError?: unknown;
};

const firstProcessId = 101;
const firstProcessStartedAt = "2026-07-31T20:00:00.000Z";
const secondProcessId = 202;
const secondProcessStartedAt = "2026-07-31T20:01:00.000Z";

const makeWorld = Effect.gen(function* () {
  const { baseUrl, directory } =
    yield* makeTargetApplicationHarness(
      "acceptance-stale-inspection-",
    );
  let markInspectionStarted = (): void => undefined;
  const inspectionStarted = new Promise<void>((resolve) => {
    markInspectionStarted = resolve;
  });
  const world: World = {
    databasePath: join(directory, "state.db"),
    baseUrl,
    inspectionStarted,
    signaledProcesses: [],
    markInspectionStarted,
  };

  return yield* Effect.acquireRelease(
    Effect.succeed(world),
    (acquiredWorld) =>
      Effect.gen(function* () {
        acquiredWorld.releaseInspection?.();
        if (acquiredWorld.firstDispatch !== undefined) {
          yield* Fiber.interrupt(acquiredWorld.firstDispatch);
        }
      }).pipe(Effect.orDie),
  );
});

const processIdentity = (world: World) => ({
  isCurrent: () =>
    Effect.succeed(world.recordedOwnerIsCurrent ?? false),
});

const reporter = {
  writePassingReport: () => Effect.void,
};

const handlers: readonly StepHandler<World>[] = [
  {
    pattern:
      /^two Workflow Engine processes share a fresh durable Run Store$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^the harness assigns Run inspection-recovery with a harness-supplied Base URL$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^the first process owns the Turn with ownership token <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        world.firstOwnershipToken = exampleValue(
          example,
          captures[0],
        );
      }),
  },
  {
    pattern:
      /^it has durably recorded phase inspectingChanges with recovery policy rerun$/,
    run: (world) =>
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openSqliteRunStore(
            world.databasePath,
            { processIdentity: processIdentity(world) },
          );
          const lease = yield* store.acquireTurn(
            RunId("inspection-recovery"),
            {
              processId: firstProcessId,
              processStartedAt: firstProcessStartedAt,
              ownershipToken:
                world.firstOwnershipToken ?? "missing-token",
            },
          );
          world.firstLease = lease;
          yield* store.startInspection(
            lease,
            RunId("inspection-recovery"),
            world.baseUrl,
            "rerun",
            {
              maxScenarios: 20,
              scenarioTimeoutMs: 30_000,
              activeWorkBudgetMs: 300_000,
            },
          );
        }),
      ),
  },
  {
    pattern:
      /^its Change Inspector has not checkpointed completion$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^on recovery the Change Inspector reports a <([A-Za-z0-9_]+)> change at <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        world.reportedChanges = [
          {
            kind: exampleValue(example, captures[0]) as "modified",
            path: exampleValue(example, captures[1]),
          },
        ];
      }),
  },
  {
    pattern: /^the first process terminates without cleanup$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^the Process Identity boundary reports the recorded owner as <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        const state = exampleValue(example, captures[0]);
        world.recordedOwnerIsCurrent =
          state !== "missing" && state !== "pid-reused";
      }),
  },
  {
    pattern:
      /^the second process uses ownership token <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        world.secondOwnershipToken = exampleValue(
          example,
          captures[0],
        );
      }),
  },
  {
    pattern:
      /^it dispatches the same start Event for the Run and Base URL$/,
    run: (world) =>
      Effect.gen(function* () {
        const result = yield* Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath: world.databasePath,
                changeInspector: {
                  inspect: () =>
                    Effect.succeed(world.reportedChanges ?? []),
                },
                processIdentity: processIdentity(world),
                turnOwnerFactory: () => ({
                  processId: secondProcessId,
                  processStartedAt: secondProcessStartedAt,
                  ownershipToken:
                    world.secondOwnershipToken ?? "missing-token",
                }),
                scenarioRuntime: makeDeterministicScenarioRuntime(),
                runReporter: reporter,
              });
              return yield* engine.dispatch(
                RunId("inspection-recovery"),
                { type: "start", baseUrl: world.baseUrl },
              );
            }),
          ),
        );
        if (result._tag === "Left") {
          world.secondError = result.left;
        } else {
          world.secondDispatch = result.right;
        }
      }),
  },
  {
    pattern:
      /^dispatch completes in phase <([A-Za-z0-9_]+)> with a schema-version 1 generate-plan Job$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.secondDispatch).toMatchObject({
          phase: exampleValue(example, captures[0]),
          pendingJob: {
            schemaVersion: 1,
            type: "generate-plan",
          },
        });
      }),
  },
  {
    pattern:
      /^the Job contains a <([A-Za-z0-9_]+)> change at <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.secondDispatch).toMatchObject({
          pendingJob: {
            payload: {
              changes: [
                {
                  kind: exampleValue(example, captures[0]),
                  path: exampleValue(example, captures[1]),
                },
              ],
            },
          },
        });
      }),
  },
  {
    pattern: /^getPendingJob returns the same Job for the Run$/,
    run: (world) =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createWorkflowEngine({
            databasePath: world.databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
            readOnly: true,
          });
          const pendingJob = yield* engine.getPendingJob(
            RunId("inspection-recovery"),
          );
          expect(pendingJob).toEqual(
            world.secondDispatch?.phase === "awaitingAgent"
              ? world.secondDispatch.pendingJob
              : undefined,
          );
        }),
      ),
  },
  {
    pattern:
      /^getStatus reports the Run in phase <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createWorkflowEngine({
            databasePath: world.databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
            readOnly: true,
          });
          expect(
            yield* engine.getStatus(RunId("inspection-recovery")),
          ).toMatchObject({
            runId: "inspection-recovery",
            phase: exampleValue(example, captures[0]),
          });
        }),
      ),
  },
  {
    pattern:
      /^no process outside the recorded Turn ownership is signaled$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.signaledProcesses).toEqual([]);
      }),
  },
  {
    pattern:
      /^its Change Inspector remains held at a harness-controlled boundary$/,
    run: (world) =>
      Effect.gen(function* () {
        world.firstDispatch = Effect.runFork(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath: world.databasePath,
                changeInspector: {
                  inspect: () =>
                    Effect.async((resume) => {
                      world.releaseInspection = () =>
                        resume(Effect.succeed([]));
                      world.markInspectionStarted();
                    }),
                },
                processIdentity: processIdentity(world),
                turnOwnerFactory: () => ({
                  processId: firstProcessId,
                  processStartedAt: firstProcessStartedAt,
                  ownershipToken:
                    world.firstOwnershipToken ?? "missing-token",
                }),
                scenarioRuntime: makeDeterministicScenarioRuntime(),
                runReporter: reporter,
              });
              return yield* engine.dispatch(
                RunId("inspection-recovery"),
                { type: "start", baseUrl: world.baseUrl },
              );
            }),
          ),
        );
        yield* Effect.promise(() => world.inspectionStarted);
      }),
  },
  {
    pattern:
      /^the Process Identity boundary confirms its recorded process id and start time still identify that live process$/,
    run: (world) =>
      Effect.sync(() => {
        world.recordedOwnerIsCurrent = true;
      }),
  },
  {
    pattern:
      /^dispatch fails with <([A-Za-z0-9_]+)> identifying Run inspection-recovery$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.secondError).toBeInstanceOf(RunBusyError);
        expect(world.secondError).toMatchObject({
          _tag: exampleValue(example, captures[0]),
          owningRunId: "inspection-recovery",
        });
      }),
  },
  {
    pattern:
      /^getPendingJob returns no Job for the Run$/,
    run: (world) =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createWorkflowEngine({
            databasePath: world.databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
            readOnly: true,
          });
          expect(
            yield* engine.getPendingJob(RunId("inspection-recovery")),
          ).toBeNull();
        }),
      ),
  },
  {
    pattern:
      /^the first process remains held without being signaled$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.releaseInspection).toBeDefined();
        expect(world.signaledProcesses).toEqual([]);
      }),
  },
];

export const staleInspectionTurnRecovery: FeatureBindings<World> = {
  makeWorld,
  handlers,
};
