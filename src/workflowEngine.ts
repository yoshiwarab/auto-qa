import { Effect } from "effect";
import {
  PlanValidationError,
  validateGeneratePlan,
} from "./planValidation.js";
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
  InvalidTransitionError,
  allowedEvents,
  step,
  type AbandonEvent,
  type ExternalEvent,
  type MachinePhase,
  type MachineSnapshot,
  type RunId,
  type StartEvent,
  type SubmitJobEvent,
} from "./workflowMachine.js";
import type {
  Change,
  DispatchResult,
  GeneratePlanJob,
  RunStatus,
} from "./workflowProtocol.js";

export type {
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
  | RunBusyError
  | RunNotFoundError
  | TurnOwnershipLostError
  | WorkflowStoreError;

export interface WorkflowEngine {
  readonly dispatch: {
    (
      runId: RunId,
      event: StartEvent,
    ): Effect.Effect<DispatchResult, WorkflowError>;
    (
      runId: RunId,
      event: AbandonEvent,
    ): Effect.Effect<RunStatus, WorkflowError>;
    (
      runId: RunId,
      event: SubmitJobEvent,
    ): Effect.Effect<DispatchResult, WorkflowError>;
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
} as const;

type AutomaticPhase = keyof typeof AUTOMATIC_PHASES;

const isAutomaticPhase = (
  phase: MachinePhase,
): phase is AutomaticPhase => phase in AUTOMATIC_PHASES;

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
  void,
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

const runAutomaticPhases = (
  initialSnapshot: MachineSnapshot,
  lease: TurnLease,
  runStore: RunStore,
  changeInspector: ChangeInspector,
): Effect.Effect<DispatchResult, WorkflowError> =>
  Effect.gen(function* () {
    let snapshot = initialSnapshot;
    let pendingJob: GeneratePlanJob | undefined;

    while (isAutomaticPhase(snapshot.phase)) {
      const work = AUTOMATIC_PHASES[snapshot.phase];
      const result = yield* work.work(snapshot, changeInspector);
      const transition = step(snapshot, result.event);
      const next =
        transition._tag === "Left"
          ? yield* Effect.fail(transition.left)
          : transition.right;
      pendingJob = createGeneratePlanJob(next, result.changes);
      yield* runStore.completeInspection(
        lease,
        snapshot.runId,
        pendingJob,
      );
      snapshot = next;
    }

    if (
      snapshot.phase !== "awaitingAgent" ||
      pendingJob === undefined
    ) {
      return yield* Effect.fail(
        new InvalidTransitionError({
          phase: snapshot.phase,
          event: "changesInspected",
          allowedEvents: allowedEvents(snapshot.phase),
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
  makeTurnOwner,
}: {
  readonly runStore: RunStore;
  readonly changeInspector: ChangeInspector;
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
            yield* validatePendingGeneratePlan(
              persisted,
              event,
              runStore,
            );
            return yield* Effect.fail(
              new InvalidTransitionError({
                phase: persisted.phase,
                event: event.type,
                allowedEvents: allowedEvents(persisted.phase),
              }),
            );
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

          return yield* runAutomaticPhases(
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
