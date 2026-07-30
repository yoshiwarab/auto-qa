import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { expect } from "vitest";
import {
  RunBusyError,
  RunId,
  createWorkflowEngine,
  type DispatchResult,
  type WorkflowError,
} from "../src/index.js";
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
  markInspectionStarted: () => void;
  releaseInspection?: () => void;
  firstDispatch?: Fiber.RuntimeFiber<DispatchResult, WorkflowError>;
  secondError?: unknown;
  busyStatus?: unknown;
  busyJob?: unknown;
  completed?: DispatchResult;
};

const createNoChangeEngine = (
  world: World,
  readOnly = false,
) =>
  createWorkflowEngine({
    databasePath: world.databasePath,
    changeInspector: {
      inspect: () => Effect.succeed([]),
    },
    readOnly,
  });

const makeWorld = Effect.gen(function* () {
  const { baseUrl, directory } =
    yield* makeTargetApplicationHarness(
      "acceptance-fenced-turn-",
    );
  let markInspectionStarted = (): void => undefined;
  const inspectionStarted = new Promise<void>((resolve) => {
    markInspectionStarted = resolve;
  });
  const world: World = {
    databasePath: join(directory, "state.db"),
    baseUrl,
    inspectionStarted,
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

const handlers: readonly StepHandler<World>[] = [
  {
    pattern:
      /^two Workflow Engines share a fresh durable Run Store$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^the first engine uses a Change Inspector held at a harness-controlled boundary$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^the first engine dispatches a start Event for a Run with a harness-supplied Base URL$/,
    run: (world) =>
      Effect.sync(() => {
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
              });
              return yield* engine.dispatch(RunId("first-run"), {
                type: "start",
                baseUrl: world.baseUrl,
              });
            }),
          ),
        );
      }),
  },
  {
    pattern: /^the Change Inspector has begun and remains held$/,
    run: (world) => Effect.promise(() => world.inspectionStarted),
  },
  {
    pattern:
      /^the second engine dispatches a start Event for a different Run$/,
    run: (world) =>
      Effect.gen(function* () {
        const result = yield* Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createNoChangeEngine(world);
              return yield* engine.dispatch(RunId("second-run"), {
                type: "start",
                baseUrl: world.baseUrl,
              });
            }),
          ),
        );
        if (result._tag === "Left") world.secondError = result.left;
      }),
  },
  {
    pattern:
      /^the second engine dispatch returns while the Change Inspector remains held$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.secondError).toBeDefined();
        expect(world.releaseInspection).toBeDefined();
        expect(world.completed).toBeUndefined();
      }),
  },
  {
    pattern:
      /^the second engine dispatch fails with <([A-Za-z0-9_]+)> identifying the first Run$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.secondError).toBeInstanceOf(RunBusyError);
        expect(world.secondError).toMatchObject({
          _tag: exampleValue(example, captures[0]),
          owningRunId: "first-run",
        });
      }),
  },
  {
    pattern:
      /^a concurrent getStatus call reports the first Run in phase <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.gen(function* () {
        world.busyStatus = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createNoChangeEngine(world, true);
            return yield* engine.getStatus(RunId("first-run"));
          }),
        );
        expect(world.busyStatus).toMatchObject({
          runId: "first-run",
          phase: exampleValue(example, captures[0]),
        });
      }),
  },
  {
    pattern:
      /^a concurrent getPendingJob call returns no Job for the first Run$/,
    run: (world) =>
      Effect.gen(function* () {
        world.busyJob = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createNoChangeEngine(world, true);
            return yield* engine.getPendingJob(RunId("first-run"));
          }),
        );
        expect(world.busyJob).toBeNull();
      }),
  },
  {
    pattern:
      /^the harness releases the Change Inspector with no changes$/,
    run: (world) =>
      Effect.sync(() => {
        world.releaseInspection?.();
      }),
  },
  {
    pattern:
      /^the first dispatch completes in phase <([A-Za-z0-9_]+)> with a schema-version 1 generate-plan Job$/,
    run: (world, example, captures) =>
      Effect.gen(function* () {
        if (world.firstDispatch === undefined) {
          return yield* Effect.fail(
            new Error("First dispatch was not started"),
          );
        }
        world.completed = yield* Fiber.join(world.firstDispatch);
        expect(world.completed).toMatchObject({
          phase: exampleValue(example, captures[0]),
          pendingJob: {
            schemaVersion: 1,
            type: "generate-plan",
          },
        });
      }),
  },
];

export const workflowFencedTurn: FeatureBindings<World> = {
  makeWorld,
  handlers,
};
