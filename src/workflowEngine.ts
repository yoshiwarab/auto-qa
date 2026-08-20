import { createHash } from "node:crypto";
import { Clock, Data, Effect } from "effect";
import type { ProcessIdentityError } from "./processIdentity.js";
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
  AttemptRecord,
  AwaitingAgentDispatchResult,
  Change,
  ClassifyFindingsDispatchResult,
  CompletedDispatchResult,
  DispatchResult,
  GeneratePlanJob,
  Job,
  RunStatus,
} from "./workflowProtocol.js";

export type {
  AwaitingAgentDispatchResult,
  ClassifyFindingsDispatchResult,
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

const activeWorkBudgetExceeded = (
  runId: RunId,
): RunBudgetExceededError =>
  new RunBudgetExceededError({
    runId,
    message: `Run ${runId} exhausted its active-work budget`,
  });

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
  | ProcessIdentityError
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
    ): Effect.Effect<
      CompletedDispatchResult | ClassifyFindingsDispatchResult,
      WorkflowError
    >;
  };
  readonly getPendingJob: (
    runId: RunId,
  ) => Effect.Effect<Job | null, WorkflowError>;
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
      checkpointActiveWork: (elapsedMs: number) => void,
    ) =>
      runtime.execute(attempt, {
        baseUrl,
        timeoutMs,
        checkpointActiveWork,
      }),
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

const canonicalize = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalize)
    : typeof value === "object" && value !== null
    ? Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      )
    : value;

const submissionHash = (payload: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)) ?? "undefined")
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

const getRemainingActiveWorkMs = (
  runId: RunId,
  activeWorkBudgetMs: number,
  runStore: RunStore,
) =>
  Effect.gen(function* () {
    const usedWork = yield* runStore.getActiveWorkMs(runId);
    const remainingWork = activeWorkBudgetMs - usedWork;
    if (remainingWork <= 0) {
      return yield* Effect.fail(
        activeWorkBudgetExceeded(runId),
      );
    }
    return remainingWork;
  });

const runWithinActiveWorkBudget = <
  Result,
  Failure,
  Requirements,
>(
  lease: TurnLease,
  runId: RunId,
  activeWorkBudgetMs: number,
  runStore: RunStore,
  work: (
    remainingWorkMs: number,
  ) => Effect.Effect<Result, Failure, Requirements>,
) =>
  Effect.gen(function* () {
    const remainingWork = yield* getRemainingActiveWorkMs(
      runId,
      activeWorkBudgetMs,
      runStore,
    );
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* Effect.either(
      work(remainingWork).pipe(
        Effect.timeoutFail({
          duration: remainingWork,
          onTimeout: () => activeWorkBudgetExceeded(runId),
        }),
      ),
    );
    const finishedAt = yield* Clock.currentTimeMillis;
    yield* runStore.recordActiveWorkMs(
      lease,
      runId,
      finishedAt - startedAt,
    );
    if (result._tag === "Left") {
      return yield* Effect.fail(result.left);
    }
    return result.right;
  });

const runChangeInspection = (
  initialSnapshot: MachineSnapshot,
  lease: TurnLease,
  runStore: RunStore,
  changeInspector: ChangeInspector,
  planLimits: PlanLimits,
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
    const result = yield* runWithinActiveWorkBudget(
      lease,
      initialSnapshot.runId,
      planLimits.activeWorkBudgetMs,
      runStore,
      () =>
        AUTOMATIC_PHASES.inspectingChanges.work(
          initialSnapshot,
          changeInspector,
        ),
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

const recoverInterruptedScenario = (
  run: RunRecord,
  lease: TurnLease,
  runStore: RunStore,
): Effect.Effect<ClassifyFindingsDispatchResult, WorkflowError> =>
  Effect.gen(function* () {
    const transition = step(run, {
      type: "scenarioExecutionInterrupted",
    });
    if (transition._tag === "Left") {
      return yield* Effect.fail(transition.left);
    }
    const pendingJob = yield* runStore.recordInterruptedScenario(
      lease,
      run.runId,
    );
    if (pendingJob === null) {
      return yield* Effect.fail(
        new InvalidTransitionError({
          phase: run.phase,
          event: "scenarioExecutionInterrupted",
          allowedEvents: allowedEvents(run.phase),
        }),
      );
    }
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
  Error | ProcessIdentityError | RunBusyError | WorkflowStoreError
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
  readonly makeTurnOwner: () => Effect.Effect<
    TurnOwner,
    ProcessIdentityError
  >;
}): WorkflowEngine => {
  const dispatch = (
    runId: RunId,
    event: ExternalEvent,
  ): Effect.Effect<DispatchResult | RunStatus, WorkflowError> =>
    Effect.flatMap(makeTurnOwner(), (turnOwner) =>
      withTurn(runId, turnOwner, runStore, (lease) =>
        Effect.gen(function* () {
          const persisted = yield* runStore.loadRun(runId);
          if (event.type === "submitJob") {
            if (persisted === null) {
              return yield* Effect.fail(
                new RunNotFoundError({ runId }),
              );
            }
            const hash = submissionHash(event.payload);
            const runLimits = persisted.planLimits;
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
            if (priorSubmission?.status === "accepted") {
              if (priorSubmission.submissionHash !== hash) {
                return yield* Effect.fail(
                  new JobSubmissionConflictError({
                    jobId: event.jobId,
                    message: `Job ${event.jobId} was already accepted with a different submission`,
                  }),
                );
              }
              if (
                persisted.phase === "executingScenarios" &&
                lease.recoveredStaleOwner
              ) {
                return yield* recoverInterruptedScenario(
                  persisted,
                  lease,
                  runStore,
                );
              }
              if (persisted.phase === "awaitingAgent") {
                const pendingJob = yield* runStore.getPendingJob(runId);
                if (pendingJob?.type === "classify-findings") {
                  return {
                    phase: "awaitingAgent",
                    pendingJob,
                  };
                }
              }
            }
            const { accepted, frozenScenarios } =
              yield* runWithinActiveWorkBudget(
                lease,
                runId,
                runLimits.activeWorkBudgetMs,
                runStore,
                () =>
                  Effect.gen(function* () {
                    const scenarios =
                      yield* validatePendingGeneratePlan(
                        persisted,
                        event,
                        runStore,
                        runLimits,
                      );
                    const accepted = step(persisted, event);
                    if (accepted._tag === "Left") {
                      return yield* Effect.fail(accepted.left);
                    }
                    const frozenScenarios =
                      yield* runStore.acceptPlan(
                        lease,
                        runId,
                        scenarios,
                        hash,
                      );
                    return {
                      accepted: accepted.right,
                      frozenScenarios,
                    };
                  }),
              );
            const attempts: AttemptRecord[] = [];
            let evaluatedSnapshot: MachineSnapshot | undefined;
            for (const [
              index,
              scenario,
            ] of frozenScenarios.entries()) {
              const remainingWork =
                yield* getRemainingActiveWorkMs(
                  runId,
                  runLimits.activeWorkBudgetMs,
                  runStore,
                );
              const startedAt = yield* Clock.currentTimeMillis;
              let activeWorkCheckpointMs: number | undefined;
              const scenarioLimitIsBinding =
                runLimits.scenarioTimeoutMs <= remainingWork;
              const effectiveTimeout = Math.min(
                runLimits.scenarioTimeoutMs,
                remainingWork,
              );
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
                  effectiveTimeout,
                  (elapsedMs) => {
                    activeWorkCheckpointMs = elapsedMs;
                  },
                  ).pipe(
                    Effect.timeoutFail({
                      duration: effectiveTimeout,
                      onTimeout: () =>
                        scenarioLimitIsBinding
                          ? new ScenarioRuntimeError({
                              operation: "execute Scenario",
                              cause: new Error(
                                `Scenario timed out after ${effectiveTimeout}ms`,
                              ),
                            })
                          : activeWorkBudgetExceeded(runId),
                    }),
                  ),
                );
              yield* runStore.recordActiveWorkMs(
                lease,
                runId,
                activeWorkCheckpointMs ??
                  (yield* Clock.currentTimeMillis) - startedAt,
              );
              if (execution._tag === "Left") {
                return yield* Effect.fail(execution.left);
              }
              const attempt = execution.right.attempt;
              attempts.push(attempt);
              const nextScenario = frozenScenarios[index + 1];
              if (nextScenario === undefined) {
                const evaluated = step(accepted, {
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
                  phase: accepted.phase,
                  event: "scenarioBatchCompleted",
                  allowedEvents: allowedEvents(
                    accepted.phase,
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
            yield* runWithinActiveWorkBudget(
              lease,
              runId,
              runLimits.activeWorkBudgetMs,
              runStore,
              () =>
                AUTOMATIC_PHASES.reporting.work(
                  runReporter,
                  runId,
                  attempts,
                ),
            );
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
              planLimits,
            );
          }

          return yield* runChangeInspection(
            inspecting,
            lease,
            runStore,
            changeInspector,
            persisted?.planLimits ?? planLimits,
          );
        }),
      ),
    );

  return {
    dispatch: dispatch as WorkflowEngine["dispatch"],
    getPendingJob: (runId) => runStore.getPendingJob(runId),
    getStatus: (runId) => runStore.getStatus(runId),
  };
};
