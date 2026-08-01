import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { expect } from "vitest";
import {
  RunBusyError,
  RunId,
  createWorkflowEngine,
  makeDeterministicScenarioRuntime,
  type ChangeInspector,
  type DispatchResult,
  type WorkflowError,
} from "../src/index.js";
import type {
  TurnLease,
  TurnOwner,
} from "../src/runStore.js";
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
  readonly unrelatedProcess: ChildProcess;
  markInspectionStarted: () => void;
  firstOwnershipToken?: string;
  firstLease?: TurnLease;
  secondOwnershipToken?: string;
  recordedOwnerState?: string;
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
const secondProcessId = 202;
const runId = RunId("inspection-recovery");

const isRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

const stopProcess = (child: ChildProcess): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    if (!isRunning(child)) {
      resume(Effect.void);
      return;
    }
    const finished = (): void => {
      child.off("exit", finished);
      resume(Effect.void);
    };
    child.once("exit", finished);
    child.kill("SIGKILL");
    return Effect.sync(() => child.off("exit", finished));
  }).pipe(Effect.interruptible);

const makeWorld = Effect.gen(function* () {
  const { baseUrl, directory } =
    yield* makeTargetApplicationHarness(
      "acceptance-stale-inspection-",
    );
  let markInspectionStarted = (): void => undefined;
  const inspectionStarted = new Promise<void>((resolve) => {
    markInspectionStarted = resolve;
  });
  const unrelatedProcess = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1_000)"],
        { stdio: "ignore" },
      ),
    ),
    (child) => stopProcess(child).pipe(Effect.orDie),
  );
  const world: World = {
    databasePath: join(directory, "state.db"),
    baseUrl,
    inspectionStarted,
    unrelatedProcess,
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
  isRunning: () =>
    Effect.succeed(world.recordedOwnerIsCurrent ?? false),
});

const reporter = {
  writePassingReport: () => Effect.void,
};

const firstTurnOwner = (world: World): TurnOwner => ({
  processId:
    world.recordedOwnerState === "pid-reused"
      ? world.unrelatedProcess.pid ?? firstProcessId
      : firstProcessId,
  processIncarnation: {
    bootId: "recorded-boot",
    startTicks: "100",
  },
  ownershipToken: world.firstOwnershipToken ?? "missing-token",
});

const secondTurnOwner = (world: World): TurnOwner => ({
  processId: secondProcessId,
  processIncarnation: {
    bootId: "replacement-boot",
    startTicks: "200",
  },
  ownershipToken: world.secondOwnershipToken ?? "missing-token",
});

const createMutableEngine = (
  world: World,
  changeInspector: ChangeInspector,
  turnOwner: TurnOwner,
) =>
  createWorkflowEngine({
    databasePath: world.databasePath,
    changeInspector,
    processIdentity: processIdentity(world),
    turnOwnerFactory: () => turnOwner,
    scenarioRuntime: makeDeterministicScenarioRuntime(),
    runReporter: reporter,
  });

const createReadOnlyEngine = (world: World) =>
  createWorkflowEngine({
    databasePath: world.databasePath,
    changeInspector: { inspect: () => Effect.succeed([]) },
    readOnly: true,
  });

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
      /^the first process owns the Turn with ownership token ([A-Za-z0-9-]+)$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        const ownershipToken = captures[0];
        if (ownershipToken === undefined) {
          throw new Error("Missing first Turn ownership token");
        }
        world.firstOwnershipToken = ownershipToken;
        world.recordedOwnerState =
          example["stale_owner_state"] ?? "live";
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
            runId,
            firstTurnOwner(world),
          );
          world.firstLease = lease;
          yield* store.startInspection(
            lease,
            runId,
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
        world.recordedOwnerState = state;
        world.recordedOwnerIsCurrent =
          state !== "missing" && state !== "pid-reused";
      }),
  },
  {
    pattern:
      /^the second process uses ownership token ([A-Za-z0-9-]+)$/,
    run: (world, _example, captures) =>
      Effect.sync(() => {
        const ownershipToken = captures[0];
        if (ownershipToken === undefined) {
          throw new Error("Missing second Turn ownership token");
        }
        world.secondOwnershipToken = ownershipToken;
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
              const engine = yield* createMutableEngine(
                world,
                {
                  inspect: () =>
                    Effect.succeed(world.reportedChanges ?? []),
                },
                secondTurnOwner(world),
              );
              return yield* engine.dispatch(
                runId,
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
          const engine = yield* createReadOnlyEngine(world);
          const pendingJob = yield* engine.getPendingJob(runId);
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
          const engine = yield* createReadOnlyEngine(world);
          expect(yield* engine.getStatus(runId)).toMatchObject({
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
        expect(isRunning(world.unrelatedProcess)).toBe(true);
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
              const engine = yield* createMutableEngine(
                world,
                {
                  inspect: () =>
                    Effect.async((resume) => {
                      world.releaseInspection = () =>
                        resume(Effect.succeed([]));
                      world.markInspectionStarted();
                    }),
                },
                firstTurnOwner(world),
              );
              return yield* engine.dispatch(
                runId,
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
          const engine = yield* createReadOnlyEngine(world);
          expect(yield* engine.getPendingJob(runId)).toBeNull();
        }),
      ),
  },
  {
    pattern:
      /^the first process remains held without being signaled$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.releaseInspection).toBeDefined();
        expect(isRunning(world.unrelatedProcess)).toBe(true);
      }),
  },
];

export const staleInspectionTurnRecovery: FeatureBindings<World> = {
  makeWorld,
  handlers,
};
