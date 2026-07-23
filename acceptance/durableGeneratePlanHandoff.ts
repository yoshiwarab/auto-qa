import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  RunId,
  RunNotFoundError,
  createWorkflowEngine,
  type Change,
  type ChangeInspector,
  type DispatchResult,
  type GeneratePlanJob,
  type RunStatus,
} from "../src/index.js";
import type {
  FeatureBindings,
  StepHandler,
} from "./runtime.js";

type World = {
  readonly databasePath: string;
  readonly runId: ReturnType<typeof RunId>;
  readonly baseUrl: URL;
  changes: readonly Change[];
  dispatchResult?: DispatchResult;
  restartedJob?: GeneratePlanJob | null;
  restartedStatus?: RunStatus;
};

const listen = (server: Server): Effect.Effect<URL, Error> =>
  Effect.async<URL, Error>((resume) => {
    const onError = (cause: Error): void => {
      server.off("listening", onListening);
      resume(Effect.fail(cause));
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      resume(Effect.succeed(new URL(`http://127.0.0.1:${address.port}`)));
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

const close = (server: Server): Effect.Effect<void, Error> =>
  Effect.async<void, Error>((resume) => {
    server.close((cause) => {
      resume(cause === undefined ? Effect.void : Effect.fail(cause));
    });
  });

const makeWorld = Effect.acquireRelease(
  Effect.gen(function* () {
    const temporaryParent = join(process.cwd(), "tmp");
    yield* Effect.promise(() => mkdir(temporaryParent, { recursive: true }));
    const directory = yield* Effect.promise(() =>
      mkdtemp(join(temporaryParent, "acceptance-workflow-")),
    );
    const targetApplication = createServer((_request, response) => {
      response.end("ok");
    });
    const baseUrl = yield* listen(targetApplication);

    return {
      directory,
      targetApplication,
      world: {
        databasePath: join(directory, "state.db"),
        runId: RunId("acceptance-run-001"),
        baseUrl,
        changes: [],
      } satisfies World,
    };
  }),
  ({ directory, targetApplication }) =>
    Effect.zipRight(
      close(targetApplication),
      Effect.promise(() => rm(directory, { recursive: true })),
    ).pipe(Effect.orDie),
).pipe(Effect.map(({ world }) => world));

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
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath: world.databasePath,
                changeInspector: {
                  inspect: () => Effect.succeed([]),
                },
              });
              return yield* engine.getStatus(world.runId);
            }),
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
        world.dispatchResult = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath: world.databasePath,
              changeInspector,
            });
            return yield* engine.dispatch(world.runId, {
              type: "start",
              baseUrl: world.baseUrl,
            });
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
        world.restartedJob = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath: world.databasePath,
              changeInspector: {
                inspect: () => Effect.succeed([]),
              },
            });
            return yield* engine.getPendingJob(world.runId);
          }),
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
        world.restartedStatus = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath: world.databasePath,
              changeInspector: {
                inspect: () => Effect.succeed([]),
              },
            });
            return yield* engine.getStatus(world.runId);
          }),
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
