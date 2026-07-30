import { createHash } from "node:crypto";
import { Clock, Data, Effect } from "effect";
import {
  PlanValidationError,
  type PlanLimits,
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
import {
  ScenarioRuntimeError,
  type ScenarioRuntime,
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

export class JobSubmissionConflictError extends Data.TaggedError(
  "JobSubmissionConflictError",
)<{
  readonly jobId: string;
  readonly message: string;
}> {}

export class RunBudgetExceededError extends Data.TaggedError(
  "RunBudgetExceededError",
)<{
  readonly runId: string;
  readonly message: string;
}> {}

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
  | JobSubmissionConflictError
  | PlanValidationError
  | RunReportError
  | RunBusyError
  | RunBudgetExceededError
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
      timeoutMs: number,
    ) => runtime.execute(attempt, { baseUrl, timeoutMs }),
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
  limits: PlanLimits,
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
    const validation = validateGeneratePlan(
      event.payload,
      limits,
    );
    if (validation._tag === "Left") {
      return yield* Effect.fail(validation.left);
    }
    return validation.right;
  });

const submissionHash = (payload: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(payload) ?? "undefined")
    .digest("hex");

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
  planLimits,
  makeTurnOwner,
}: {
  readonly runStore: RunStore;
  readonly changeInspector: ChangeInspector;
  readonly scenarioRuntime: ScenarioRuntime;
  readonly runReporter: RunReporter;
  readonly planLimits: PlanLimits;
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
            const hash = submissionHash(event.payload);
            const priorSubmission =
              yield* runStore.getJobSubmission(runId, event.jobId);
            if (
              priorSubmission?.status === "completed" &&
              priorSubmission.result !== null
            ) {
              if (priorSubmission.submissionHash === hash) {
                return priorSubmission.result;
              }
              return yield* Effect.fail(
                new JobSubmissionConflictError({
                  jobId: event.jobId,
                  message: `Job ${event.jobId} was already completed with a different submission`,
                }),
              );
            }
            const scenarios = yield* validatePendingGeneratePlan(
              persisted,
              event,
              runStore,
              planLimits,
            );
            const accepted = step(persisted, event);
            if (accepted._tag === "Left") {
              return yield* Effect.fail(accepted.left);
            }
            const frozenScenarios = yield* runStore.acceptPlan(
              lease,
              runId,
              scenarios,
              hash,
            );
            const attempts = [];
            let evaluatedSnapshot: MachineSnapshot | undefined;
            for (const [
              index,
              scenario,
            ] of frozenScenarios.entries()) {
              const usedWork =
                yield* runStore.getActiveWorkMs(runId);
              const remainingWork =
                planLimits.activeWorkBudgetMs - usedWork;
              if (remainingWork <= 0) {
                return yield* Effect.fail(
                  new RunBudgetExceededError({
                    runId,
                    message: `Run ${runId} exhausted its active-work budget`,
                  }),
                );
              }
              const startedAt = yield* Clock.currentTimeMillis;
              const execution =
                yield* Effect.either(
                  AUTOMATIC_PHASES.executingScenarios.work(
                  scenarioRuntime,
                  {
                    runId,
                    scenario,
                    attemptNumber: 1,
                    scriptVersion: 0,
                  },
                  persisted.baseUrl,
                  Math.min(
                    planLimits.scenarioTimeoutMs,
                    remainingWork,
                  ),
                  ).pipe(
                    Effect.timeoutFail({
                      duration: Math.min(
                        planLimits.scenarioTimeoutMs,
                        remainingWork,
                      ),
                      onTimeout: () =>
                        new ScenarioRuntimeError({
                          operation: "execute Scenario",
                          cause: new Error(
                            `Scenario timed out after ${Math.min(
                              planLimits.scenarioTimeoutMs,
                              remainingWork,
                            )}ms`,
                          ),
                        }),
                    }),
                  ),
                );
              const finishedAt = yield* Clock.currentTimeMillis;
              yield* runStore.recordActiveWorkMs(
                lease,
                runId,
                finishedAt - startedAt,
              );
              if (execution._tag === "Left") {
                return yield* Effect.fail(execution.left);
              }
              const attempt = execution.right;
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
            const usedWork =
              yield* runStore.getActiveWorkMs(runId);
            const remainingWork =
              planLimits.activeWorkBudgetMs - usedWork;
            if (remainingWork <= 0) {
              return yield* Effect.fail(
                new RunBudgetExceededError({
                  runId,
                  message: `Run ${runId} exhausted its active-work budget`,
                }),
              );
            }
            const reportStartedAt = yield* Clock.currentTimeMillis;
            const reporting = yield* Effect.either(
              AUTOMATIC_PHASES.reporting
                .work(runReporter, runId, attempts)
                .pipe(
                  Effect.timeoutFail({
                    duration: remainingWork,
                    onTimeout: () =>
                      new RunBudgetExceededError({
                        runId,
                        message: `Run ${runId} exhausted its active-work budget`,
                      }),
                  }),
                ),
            );
            const reportFinishedAt = yield* Clock.currentTimeMillis;
            yield* runStore.recordActiveWorkMs(
              lease,
              runId,
              reportFinishedAt - reportStartedAt,
            );
            if (reporting._tag === "Left") {
              return yield* Effect.fail(reporting.left);
            }
            const result = {
              phase: "completed",
              outcome: "passed",
              attempts,
            } as const;
            yield* runStore.completePassingReport(
              lease,
              runId,
              result,
            );
            return result;
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
