import { join } from "node:path";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  RunId,
  createWorkflowEngine,
  type GeneratePlanJob,
} from "../src/index.js";
import {
  exampleValue,
  type FeatureBindings,
  type StepHandler,
} from "./runtime.js";
import { makeTargetApplicationHarness } from "./targetApplicationHarness.js";

type World = {
  readonly databasePath: string;
  readonly runId: ReturnType<typeof RunId>;
  readonly baseUrl: URL;
  readonly scenarios: unknown[];
  pendingJob?: GeneratePlanJob;
  rejection?: unknown;
};

const makeWorld = makeTargetApplicationHarness(
  "acceptance-invalid-plan-",
).pipe(
  Effect.map(
    ({ directory, baseUrl }): World => ({
      databasePath: join(directory, "state.db"),
      runId: RunId("acceptance-invalid-plan-001"),
      baseUrl,
      scenarios: [],
    }),
  ),
);

const createEngine = (world: World) =>
  createWorkflowEngine({
    databasePath: world.databasePath,
    changeInspector: {
      inspect: () => Effect.succeed([]),
    },
  });

const scenarioSubmission = (
  id: string,
): Record<string, unknown> => ({
  id,
  goal: `Verify ${id}`,
  preconditions: [],
  mutates: false,
  script:
    "async ({ page }) => { await page.getByRole('main').waitFor(); }",
});

const handlers: readonly StepHandler<World>[] = [
  {
    pattern:
      /^a Run is awaiting a schema-version 1 generate-plan Job$/,
    run: (world) =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createEngine(world);
          const started = yield* engine.dispatch(world.runId, {
            type: "start",
            baseUrl: world.baseUrl,
          });
          expect(started.pendingJob).toMatchObject({
            schemaVersion: 1,
            type: "generate-plan",
          });
          world.pendingJob = started.pendingJob;
        }),
      ),
  },
  {
    pattern:
      /^the Job submission contains valid Scenario dashboard-loads$/,
    run: (world) =>
      Effect.sync(() => {
        world.scenarios.push(
          scenarioSubmission("dashboard-loads"),
        );
      }),
  },
  {
    pattern:
      /^the same submission contains Scenario <([A-Za-z0-9_]+)> with required field <([A-Za-z0-9_]+)> omitted$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        const scenario = scenarioSubmission(
          exampleValue(example, captures[0]),
        );
        delete scenario[exampleValue(example, captures[1])];
        world.scenarios.push(scenario);
      }),
  },
  {
    pattern:
      /^the plan is submitted through the Workflow Engine for the pending Job$/,
    run: (world) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pendingJob = world.pendingJob;
          if (pendingJob === undefined) {
            return yield* Effect.fail(
              new Error("Expected a pending generate-plan Job"),
            );
          }
          const engine = yield* createEngine(world);
          world.rejection = yield* Effect.either(
            engine.dispatch(world.runId, {
              type: "submitJob",
              jobId: pendingJob.id,
              payload: {
                schemaVersion: 1,
                scenarios: world.scenarios,
              },
            }),
          );
        }),
      ),
  },
  {
    pattern:
      /^dispatch fails with error <([A-Za-z0-9_]+)> naming Scenario <([A-Za-z0-9_]+)> and required field <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.rejection).toMatchObject({
          _tag: "Left",
          left: {
            _tag: exampleValue(example, captures[0]),
            scenarioId: exampleValue(example, captures[1]),
            field: exampleValue(example, captures[2]),
          },
        });
      }),
  },
  {
    pattern: /^the Run remains in phase awaitingAgent$/,
    run: (world) =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createEngine(world);
          expect(yield* engine.getStatus(world.runId)).toEqual({
            runId: world.runId,
            phase: "awaitingAgent",
          });
        }),
      ),
  },
  {
    pattern:
      /^a restarted Workflow Engine returns the unchanged generate-plan Job$/,
    run: (world) =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createEngine(world);
          expect(
            yield* engine.getPendingJob(world.runId),
          ).toEqual(world.pendingJob);
        }),
      ),
  },
];

export const atomicGeneratePlanRejection: FeatureBindings<World> = {
  makeWorld,
  handlers,
};
