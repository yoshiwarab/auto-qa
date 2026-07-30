import { Effect } from "effect";
import {
  PlanValidationError,
  validateGeneratePlan,
} from "./planValidation.js";
import type {
  RunReportError,
  RunReporter,
} from "./runReporter.js";
import type {
  ActiveRunExistsError,
  RunBusyError,
  RunRecord,
  RunStore,
  TurnLease,
  TurnOwner,
  TurnOwnershipLostError,
  WorkflowStoreError,
} from "./runStore.js";
import { RunNotFoundError } from "./runStore.js";
import type {
  ScenarioRuntime,
  ScenarioRuntimeError,
} from "./scenarioRuntime.js";
import {
  InvalidTransitionError,
  allowedEvents,
  step,
  type AbandonEvent,
  type ExternalEvent,
  type MachineSnapshot,
  type RunId,
  type StartEvent,
  type SubmitJobEvent,
} from "./workflowMachine.js";
import type {
  AwaitingAgentDispatchResult,
  Change,
  CompletedDispatchResult,
  DispatchResult,
  GeneratePlanJob,
  RunStatus,
} from "./workflowProtocol.js";

export type {
  AwaitingAgentDispatchResult,
  CompletedDispatchResult,
  Change,
  DispatchResult,
  GeneratePlanJob,
  RunStatus,
} from "./workflowProtocol.js";

export class ChangeInspectionError {
  readonly _tag = "ChangeInspectionError";

  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export interface ChangeInspector {
  readonly inspect: () => Effect.Effect<
    readonly Change[],
    ChangeInspectionError
  >;
}

export type WorkflowError =
  | ActiveRunExistsError
  | ChangeInspectionError
  | InvalidTransitionError
  | PlanValidationError
  | RunReportError
  | RunBusyError
  | RunNotFoundError
  | ScenarioRuntimeError
  | TurnOwnershipLostError
  | WorkflowStoreError;

export interface WorkflowEngine {
  readonly dispatch: {
    (
      runId: RunId,
      event: StartEvent,
    ): Effect.Effect<AwaitingAgentDispatchResult, WorkflowError>;
    (
      runId: RunId,
      event: AbandonEvent,
    ): Effect.Effect<RunStatus, WorkflowError>;
    (
      runId: RunId,
      event: SubmitJobEvent,
    ): Effect.Effect<CompletedDispatchResult, WorkflowError>;
  };
  readonly getPendingJob: (
    runId: RunId,
  ) => Effect.Effect<GeneratePlanJob | null, WorkflowError>;
  readonly getStatus: (
    runId: RunId,
  ) => Effect.Effect<RunStatus, WorkflowError>;
}

export const AUTOMATIC_PHASES = {
  inspectingChanges: {
    recoveryPolicy: "rerun",
    work: (
      snapshot: MachineSnapshot,
      changeInspector: ChangeInspector,
    ) =>
      Effect.map(
        changeInspector.inspect(),
        (changes) => ({
          event: { type: "changesInspected" } as const,
          changes,
        }),
      ),
  },
  executingScenarios: {
    recoveryPolicy: "record-interrupted",
    work: (
      runtime: ScenarioRuntime,
      attempt: Parameters<ScenarioRuntime["execute"]>[0],
      baseUrl: URL,
    ) => runtime.execute(attempt, { baseUrl }),
  },
  reporting: {
    recoveryPolicy: "rerun",
    work: (
      reporter: RunReporter,
      runId: string,
      attempts: Parameters<RunReporter["writePassingReport"]>[1],
    ) => reporter.writePassingReport(runId, attempts),
  },
} as const;

const recoveredSnapshot = (
  run: RunRecord,
  event: StartEvent,
): Effect.Effect<MachineSnapshot, InvalidTransitionError> =>
  run.phase === "inspectingChanges" &&
  run.baseUrl.href === event.baseUrl.href
    ? Effect.succeed(run)
    : Effect.fail(
        new InvalidTransitionError({
          phase: run.phase,
          event: event.type,
          allowedEvents: allowedEvents(run.phase),
        }),
      );

const validatePendingGeneratePlan = (
  run: RunRecord,
  event: SubmitJobEvent,
  runStore: RunStore,
): Effect.Effect<
  readonly import("./planValidation.js").ScenarioSubmission[],
  PlanValidationError | InvalidTransitionError | WorkflowStoreError
> =>
  Effect.gen(function* () {
    const pendingJob = yield* runStore.getPendingJob(run.runId);
    if (
      run.phase !== "awaitingAgent" ||
      pendingJob === null ||
      pendingJob.id !== event.jobId
    ) {
      return yield* Effect.fail(
        new InvalidTransitionError({
          phase: run.phase,
          event: event.type,
          allowedEvents: allowedEvents(run.phase),
        }),
      );
    }
    const validation = validateGeneratePlan(event.payload);
    if (validation._tag === "Left") {
      return yield* Effect.fail(validation.left);
    }
    return validation.right;
  });

const createGeneratePlanJob = (
  snapshot: MachineSnapshot,
  changes: readonly Change[],
): GeneratePlanJob => ({
  schemaVersion: 1,
  id: `${snapshot.runId}:generate-plan:1`,
  type: "generate-plan",
  runId: snapshot.runId,
  payload: {
    baseUrl: snapshot.baseUrl.href,
    changes,
  },
});

const runChangeInspection = (
  initialSnapshot: MachineSnapshot,
  lease: TurnLease,
  runStore: RunStore,
  changeInspector: ChangeInspector,
): Effect.Effect<AwaitingAgentDispatchResult, WorkflowError> =>
  Effect.gen(function* () {
    if (initialSnapshot.phase !== "inspectingChanges") {
      return yield* Effect.fail(
        new InvalidTransitionError({
          phase: initialSnapshot.phase,
          event: "changesInspected",
          allowedEvents: allowedEvents(initialSnapshot.phase),
        }),
      );
    }
    const result = yield* AUTOMATIC_PHASES.inspectingChanges.work(
      initialSnapshot,
      changeInspector,
    );
    const transition = step(initialSnapshot, result.event);
    const next =
      transition._tag === "Left"
        ? yield* Effect.fail(transition.left)
        : transition.right;
    const pendingJob = createGeneratePlanJob(next, result.changes);
    yield* runStore.completeInspection(
      lease,
      initialSnapshot.runId,
      pendingJob,
    );

    return {
      phase: "awaitingAgent",
      pendingJob,
    };
  });

const withTurn = <Result, Error>(
  runId: RunId,
  turnOwner: TurnOwner,
  runStore: RunStore,
  use: (lease: TurnLease) => Effect.Effect<Result, Error>,
): Effect.Effect<
  Result,
  Error | RunBusyError | WorkflowStoreError
> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(
      runStore.acquireTurn(runId, turnOwner),
      (lease) =>
        restore(use(lease)).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Effect.zipRight(
                runStore.releaseTurn(lease),
                Effect.failCause(cause),
              ),
            onSuccess: (result) =>
              runStore
                .releaseTurn(lease)
                .pipe(Effect.as(result)),
          }),
        ),
    ),
  );

export const makeWorkflowEngine = ({
  runStore,
  changeInspector,
  scenarioRuntime,
  runReporter,
  makeTurnOwner,
}: {
  readonly runStore: RunStore;
  readonly changeInspector: ChangeInspector;
  readonly scenarioRuntime: ScenarioRuntime;
  readonly runReporter: RunReporter;
  readonly makeTurnOwner: () => TurnOwner;
}): WorkflowEngine => {
  const dispatch = (
    runId: RunId,
    event: ExternalEvent,
  ): Effect.Effect<DispatchResult | RunStatus, WorkflowError> =>
    withTurn(runId, makeTurnOwner(), runStore, (lease) =>
        Effect.gen(function* () {
          const persisted = yield* runStore.loadRun(runId);
          if (event.type === "submitJob") {
            if (persisted === null) {
              return yield* Effect.fail(
                new RunNotFoundError({ runId }),
              );
            }
            const scenarios = yield* validatePendingGeneratePlan(
              persisted,
              event,
              runStore,
            );
            const accepted = step(persisted, event);
            if (accepted._tag === "Left") {
              return yield* Effect.fail(accepted.left);
            }
            const frozenScenarios = yield* runStore.acceptPlan(
              lease,
              runId,
              scenarios,
            );
            const attempts = [];
            let evaluatedSnapshot: MachineSnapshot | undefined;
            for (const [
              index,
              scenario,
            ] of frozenScenarios.entries()) {
              const attempt =
                yield* AUTOMATIC_PHASES.executingScenarios.work(
                  scenarioRuntime,
                  {
                    runId,
                    scenario,
                    attemptNumber: 1,
                    scriptVersion: 0,
                  },
                  persisted.baseUrl,
                );
              attempts.push(attempt);
              const nextScenario = frozenScenarios[index + 1];
              if (nextScenario === undefined) {
                const evaluated = step(accepted.right, {
                  type: "scenarioBatchCompleted",
                });
                if (evaluated._tag === "Left") {
                  return yield* Effect.fail(evaluated.left);
                }
                evaluatedSnapshot = evaluated.right;
              }
              yield* runStore.completeAttempt(
                lease,
                runId,
                attempt,
                nextScenario?.id,
              );
            }
            if (evaluatedSnapshot === undefined) {
              return yield* Effect.fail(
                new InvalidTransitionError({
                  phase: accepted.right.phase,
                  event: "scenarioBatchCompleted",
                  allowedEvents: allowedEvents(
                    accepted.right.phase,
                  ),
                }),
              );
            }
            const completed = step(evaluatedSnapshot, {
              type: "reportCompleted",
            });
            if (completed._tag === "Left") {
              return yield* Effect.fail(completed.left);
            }
            yield* AUTOMATIC_PHASES.reporting.work(
              runReporter,
              runId,
              attempts,
            );
            yield* runStore.completePassingReport(lease, runId);
            return {
              phase: "completed",
              outcome: "passed",
              attempts,
            };
          }
          if (event.type === "abandon") {
            if (persisted === null) {
              return yield* Effect.fail(
                new RunNotFoundError({ runId }),
              );
            }
            const transition = step(persisted, event);
            if (transition._tag === "Left") {
              return yield* Effect.fail(transition.left);
            }
            return yield* runStore.abandon(
              lease,
              runId,
              event.reason,
            );
          }
          const initialTransition = step(
            {
              runId,
              phase: "idle",
              baseUrl: event.baseUrl,
            },
            event,
          );
          const inspecting =
            persisted === null
              ? initialTransition._tag === "Left"
                ? yield* Effect.fail(initialTransition.left)
                : initialTransition.right
              : yield* recoveredSnapshot(persisted, event);

          if (persisted === null) {
            yield* runStore.startInspection(
              lease,
              runId,
              event.baseUrl,
              AUTOMATIC_PHASES.inspectingChanges.recoveryPolicy,
            );
          }

          return yield* runChangeInspection(
            inspecting,
            lease,
            runStore,
            changeInspector,
          );
        }),
    );

  return {
    dispatch: dispatch as WorkflowEngine["dispatch"],
    getPendingJob: (runId) => runStore.getPendingJob(runId),
    getStatus: (runId) => runStore.getStatus(runId),
  };
};
