import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  RunId,
  createWorkflowEngine,
  type DispatchResult,
  type FrozenScenarioAttempt,
  type GeneratePlanJob,
  type ScenarioRuntime,
} from "../src/index.js";
import type { TurnOwner } from "../src/runStore.js";
import {
  exampleValue,
  type FeatureBindings,
  type StepHandler,
} from "./runtime.js";
import { makeTargetApplicationHarness } from "./targetApplicationHarness.js";

type RecordedAttempt = Pick<
  FrozenScenarioAttempt,
  "attemptNumber" | "scriptVersion"
> & {
  readonly scenarioId: string;
};

type PlanSubmission = {
  readonly schemaVersion: 1;
  readonly scenarios: readonly [
    {
      readonly id: string;
      readonly goal: string;
      readonly preconditions: readonly string[];
      readonly mutates: false;
      readonly script: string;
    },
  ];
};

type World = {
  readonly databasePath: string;
  readonly baseUrl: URL;
  readonly runtimeCalls: RecordedAttempt[];
  reportCount: number;
  child?: ChildProcess;
  runtimeStarted?: Promise<void>;
  generatePlanJob?: GeneratePlanJob;
  submission?: PlanSubmission;
  secondDispatch?: DispatchResult;
  secondError?: unknown;
};

const runId = RunId("interrupted-execution");
const projectRoot = process.cwd();

const secondTurnOwner: TurnOwner = {
  processId: 202,
  processIncarnation: {
    bootId: "second-process-boot",
    startTicks: "200",
  },
  ownershipToken: "second-process-turn",
};

const isRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

const stopChild = (child: ChildProcess): Effect.Effect<void> =>
  Effect.async((resume) => {
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
  });

const makeWorld = makeTargetApplicationHarness(
  "acceptance-interrupted-execution-",
).pipe(
  Effect.flatMap(({ baseUrl, directory }) =>
    Effect.acquireRelease(
      Effect.succeed<World>({
        databasePath: join(directory, "state.db"),
        baseUrl,
        runtimeCalls: [],
        reportCount: 0,
      }),
      (world) =>
        world.child === undefined
          ? Effect.void
          : stopChild(world.child).pipe(Effect.orDie),
    ),
  ),
);

const isRuntimeStartedMessage = (
  message: unknown,
): message is RecordedAttempt & { readonly type: "runtime-started" } =>
  typeof message === "object" &&
  message !== null &&
  "type" in message &&
  message.type === "runtime-started" &&
  "scenarioId" in message &&
  typeof message.scenarioId === "string" &&
  "attemptNumber" in message &&
  typeof message.attemptNumber === "number" &&
  "scriptVersion" in message &&
  typeof message.scriptVersion === "number";

const startExecutionProcess = (
  world: World,
  job: GeneratePlanJob,
  submission: PlanSubmission,
): void => {
  const child = spawn(
    process.execPath,
    [
      join(
        projectRoot,
        "dist",
        "acceptance",
        "interruptedScenarioExecutionChild.js",
      ),
      world.databasePath,
      world.baseUrl.href,
      job.id,
      JSON.stringify(submission),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  world.child = child;
  world.runtimeStarted = new Promise<void>((resolve, reject) => {
    let errors = "";
    const captureError = (chunk: Buffer): void => {
      errors += chunk.toString("utf8");
    };
    const started = (message: unknown): void => {
      if (!isRuntimeStartedMessage(message)) return;
      child.off("exit", exited);
      child.stderr?.off("data", captureError);
      child.off("message", started);
      world.runtimeCalls.push({
        scenarioId: message.scenarioId,
        attemptNumber: message.attemptNumber,
        scriptVersion: message.scriptVersion,
      });
      resolve();
    };
    const exited = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      child.off("message", started);
      child.stderr?.off("data", captureError);
      reject(
        new Error(
          `Execution child exited before the runtime started (code ${String(code)}, signal ${String(signal)})\n${errors}`,
        ),
      );
    };
    child.stderr?.on("data", captureError);
    child.on("message", started);
    child.once("exit", exited);
  });
};

const recoveryRuntime = (world: World): ScenarioRuntime => ({
  execute: (attempt) =>
    Effect.sync(() => {
      world.runtimeCalls.push({
        scenarioId: attempt.scenario.id,
        attemptNumber: attempt.attemptNumber,
        scriptVersion: attempt.scriptVersion,
      });
      return {
        attempt: {
          scenarioId: attempt.scenario.id,
          attemptNumber: attempt.attemptNumber,
          scriptVersion: attempt.scriptVersion,
          status: "passed",
          evidencePath: "unexpected-rerun",
        },
      };
    }),
});

const handlers: readonly StepHandler<World>[] = [
  {
    pattern:
      /^two Workflow Engine processes share a fresh durable Run Store$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^the harness assigns Run interrupted-execution with a harness-supplied Base URL$/,
    run: () => Effect.void,
  },
  {
    pattern:
      /^the first process submits an accepted plan containing only Scenario <([A-Za-z0-9_]+)> at Script Version <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.gen(function* () {
        const scenarioId = exampleValue(example, captures[0]);
        expect(exampleValue(example, captures[1])).toBe("0");
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath: world.databasePath,
              changeInspector: { inspect: () => Effect.succeed([]) },
            });
            return yield* engine.dispatch(runId, {
              type: "start",
              baseUrl: world.baseUrl,
            });
          }),
        );
        world.generatePlanJob = started.pendingJob;
        world.submission = {
          schemaVersion: 1,
          scenarios: [
            {
              id: scenarioId,
              goal: "The account page loads",
              preconditions: [],
              mutates: false,
              script: "async () => {}",
            },
          ],
        };
        startExecutionProcess(
          world,
          started.pendingJob,
          world.submission,
        );
      }),
  },
  {
    pattern:
      /^execution of Attempt <([A-Za-z0-9_]+)> is durably started with recovery policy <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.gen(function* () {
        expect(exampleValue(example, captures[0])).toBe("1");
        expect(exampleValue(example, captures[1])).toBe(
          "record-interrupted",
        );
        const runtimeStarted = world.runtimeStarted;
        if (runtimeStarted === undefined) {
          return yield* Effect.die(
            new Error("The execution process was not started"),
          );
        }
        yield* Effect.promise(() => runtimeStarted);
      }),
  },
  {
    pattern:
      /^its Scenario Runtime is held after receiving the Attempt but before returning a result$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.runtimeCalls).toHaveLength(1);
        expect(world.child === undefined ? false : isRunning(world.child)).toBe(
          true,
        );
      }),
  },
  {
    pattern: /^the first process terminates without cleanup$/,
    run: (world) =>
      world.child === undefined
        ? Effect.die(new Error("The execution process was not started"))
        : stopChild(world.child),
  },
  {
    pattern:
      /^the Process Identity boundary reports the recorded Turn owner as missing$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.child === undefined ? false : isRunning(world.child)).toBe(
          false,
        );
      }),
  },
  {
    pattern:
      /^the second process repeats the same generate-plan submission for the Run$/,
    run: (world) =>
      Effect.gen(function* () {
        const job = world.generatePlanJob;
        const submission = world.submission;
        if (job === undefined || submission === undefined) {
          return yield* Effect.die(
            new Error("The first process did not submit a plan"),
          );
        }
        const result = yield* Effect.either(
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* createWorkflowEngine({
                databasePath: world.databasePath,
                changeInspector: { inspect: () => Effect.succeed([]) },
                processIdentity: {
                  isRunning: () => Effect.succeed(false),
                },
                turnOwnerFactory: () => secondTurnOwner,
                scenarioRuntime: recoveryRuntime(world),
                runReporter: {
                  writePassingReport: () =>
                    Effect.sync(() => {
                      world.reportCount += 1;
                    }),
                },
              });
              return yield* engine.dispatch(runId, {
                type: "submitJob",
                jobId: job.id,
                payload: submission,
              });
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
      /^dispatch completes in phase <([A-Za-z0-9_]+)> with a schema-version 1 <([A-Za-z0-9_]+)> Job$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.secondError).toBeUndefined();
        expect(world.secondDispatch).toMatchObject({
          phase: exampleValue(example, captures[0]),
          pendingJob: {
            schemaVersion: 1,
            type: exampleValue(example, captures[1]),
          },
        });
      }),
  },
  {
    pattern:
      /^the Scenario Runtime has received Scenario <([A-Za-z0-9_]+)> Attempt <([A-Za-z0-9_]+)> at Script Version <([A-Za-z0-9_]+)> exactly once across both processes$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.runtimeCalls).toEqual([
          {
            scenarioId: exampleValue(example, captures[0]),
            attemptNumber: Number(exampleValue(example, captures[1])),
            scriptVersion: Number(exampleValue(example, captures[2])),
          },
        ]);
      }),
  },
  {
    pattern:
      /^the Job contains exactly one Finding for that Attempt with mechanical status <([A-Za-z0-9_]+)> and cause <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.sync(() => {
        expect(world.secondDispatch).toMatchObject({
          pendingJob: {
            payload: {
              findings: [
                {
                  mechanicalStatus: exampleValue(example, captures[0]),
                  cause: exampleValue(example, captures[1]),
                },
              ],
            },
          },
        });
      }),
  },
  {
    pattern:
      /^the Finding reports that no finalized Evidence Bundle is available$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.secondDispatch).toMatchObject({
          pendingJob: {
            payload: {
              findings: [{ evidenceBundle: null }],
            },
          },
        });
      }),
  },
  {
    pattern:
      /^a fresh Workflow Engine returns the same pending Job and reports phase <([A-Za-z0-9_]+)>$/,
    run: (world, example, captures) =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* createWorkflowEngine({
            databasePath: world.databasePath,
            changeInspector: { inspect: () => Effect.succeed([]) },
            readOnly: true,
          });
          const pendingJob = yield* engine.getPendingJob(runId);
          const status = yield* engine.getStatus(runId);
          expect(pendingJob).toEqual(
            world.secondDispatch?.phase === "awaitingAgent"
              ? world.secondDispatch.pendingJob
              : undefined,
          );
          expect(status).toMatchObject({
            runId: "interrupted-execution",
            phase: exampleValue(example, captures[0]),
          });
        }),
      ),
  },
  {
    pattern: /^no Run report has been finalized$/,
    run: (world) =>
      Effect.sync(() => {
        expect(world.reportCount).toBe(0);
      }),
  },
];

export const interruptedScenarioExecutionRecovery: FeatureBindings<World> = {
  makeWorld,
  handlers,
};
