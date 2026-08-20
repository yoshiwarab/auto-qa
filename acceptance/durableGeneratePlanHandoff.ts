import { join } from "node:path";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  RunId,
  RunNotFoundError,
  createWorkflowEngine,
  type Change,
  type ChangeInspector,
  type AwaitingAgentDispatchResult,
  type Job,
  type RunStatus,
  type WorkflowEngine,
} from "../src/index.js";
import type {
  FeatureBindings,
  StepHandler,
} from "./runtime.js";
import { makeTargetApplicationHarness } from "./targetApplicationHarness.js";

type World = {
  readonly databasePath: string;
  readonly runId: ReturnType<typeof RunId>;
  readonly baseUrl: URL;
  changes: readonly Change[];
  dispatchResult?: AwaitingAgentDispatchResult;
  restartedJob?: Job | null;
  restartedStatus?: RunStatus;
};

const noChangesInspector: ChangeInspector = {
  inspect: () => Effect.succeed([]),
};

const useEngine = <Result, Error, Requirements>(
  world: World,
  changeInspector: ChangeInspector,
  use: (
    engine: WorkflowEngine,
  ) => Effect.Effect<Result, Error, Requirements>,
) =>
  Effect.scoped(
    Effect.flatMap(
      createWorkflowEngine({
        databasePath: world.databasePath,
        changeInspector,
      }),
      use,
    ),
  );

const makeWorld = makeTargetApplicationHarness(
  "acceptance-workflow-",
).pipe(
  Effect.map(
    ({ baseUrl, directory }) =>
      ({
        databasePath: join(directory, "state.db"),
        runId: RunId("acceptance-run-001"),
        baseUrl,
        changes: [],
      }) satisfies World,
  ),
);

const exampleValue = (
  example: Readonly<Record<string, string>>,
  parameterName: string | undefined,
): Effect.Effect<string, Error> => {
  const value =
    parameterName === undefined ? undefined : example[parameterName];
  return value === undefined
    ? Effect.fail(
        new Error(`Missing acceptance example value: ${parameterName}`),
      )
    : Effect.succeed(value);
};

const handlers: readonly StepHandler<World>[] = [
  {
    pattern: /^a harness-assigned Run does not exist$/,
    run: (world) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          useEngine(
            world,
            noChangesInspector,
            (engine) => engine.getStatus(world.runId),
          ),
        );
        expect(error).toBeInstanceOf(RunNotFoundError);
      }),
  },
  {
    pattern:
      /^the Change Inspector reports a <([A-Za-z0-9_]+)> change at <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.gen(function* () {
        const kind = yield* exampleValue(example, captures[0]);
        const path = yield* exampleValue(example, captures[1]);
        world.changes = [{ kind, path }];
      }),
  },
  {
    pattern:
      /^a start Event with a harness-supplied Base URL is dispatched for the Run$/,
    run: (world) =>
      Effect.gen(function* () {
        const changeInspector: ChangeInspector = {
          inspect: () => Effect.succeed(world.changes),
        };
        world.dispatchResult = yield* useEngine(
          world,
          changeInspector,
          (engine) =>
            engine.dispatch(world.runId, {
              type: "start",
              baseUrl: world.baseUrl,
            }),
        );
      }),
  },
  {
    pattern:
      /^the dispatch result exposes a generate-plan Job containing the <([A-Za-z0-9_]+)> change at <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.gen(function* () {
        const expectedKind = yield* exampleValue(example, captures[0]);
        const expectedPath = yield* exampleValue(example, captures[1]);
        expect(world.dispatchResult?.pendingJob).toMatchObject({
          schemaVersion: 1,
          type: "generate-plan",
          payload: {
            changes: [{ kind: expectedKind, path: expectedPath }],
          },
        });
      }),
  },
  {
    pattern:
      /^a restarted Workflow Engine returns the same generate-plan Job for the Run$/,
    run: (world) =>
      Effect.gen(function* () {
        world.restartedJob = yield* useEngine(
          world,
          noChangesInspector,
          (engine) => engine.getPendingJob(world.runId),
        );
        expect(world.restartedJob).toEqual(
          world.dispatchResult?.pendingJob,
        );
      }),
  },
  {
    pattern:
      /^the restarted Workflow Engine reports the Run in phase awaitingAgent$/,
    run: (world) =>
      Effect.gen(function* () {
        world.restartedStatus = yield* useEngine(
          world,
          noChangesInspector,
          (engine) => engine.getStatus(world.runId),
        );
        expect(world.restartedStatus).toEqual({
          runId: "acceptance-run-001",
          phase: "awaitingAgent",
        });
      }),
  },
];

export const durableGeneratePlanHandoff: FeatureBindings<World> = {
  makeWorld,
  handlers,
};
