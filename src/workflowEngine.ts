import { Effect } from "effect";
import type {
  ActiveRunExistsError,
  RunBusyError,
  RunNotFoundError,
  RunRecord,
  RunStore,
  TurnLease,
  TurnOwner,
  TurnOwnershipLostError,
  WorkflowStoreError,
} from "./runStore.js";
import {
  InvalidTransitionError,
  allowedEvents,
  step,
  type ExternalEvent,
  type MachinePhase,
  type MachineSnapshot,
  type RunId,
  type RunPhase,
  type StartEvent,
} from "./workflowMachine.js";

export type Change = {
  readonly kind: string;
  readonly path: string;
};

export class ChangeInspectionError {
  readonly _tag = "ChangeInspectionError";

  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export interface ChangeInspector {
  readonly inspect: (
    runId: RunId,
    baseUrl: URL,
  ) => Effect.Effect<readonly Change[], ChangeInspectionError>;
}

export type GeneratePlanJob = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: "generate-plan";
  readonly runId: string;
  readonly payload: {
    readonly baseUrl: string;
    readonly changes: readonly Change[];
  };
};

export type DispatchResult = {
  readonly phase: "awaitingAgent";
  readonly pendingJob: GeneratePlanJob;
};

export type RunStatus = {
  readonly runId: string;
  readonly phase: RunPhase;
};

export type WorkflowError =
  | ActiveRunExistsError
  | ChangeInspectionError
  | InvalidTransitionError
  | RunBusyError
  | RunNotFoundError
  | TurnOwnershipLostError
  | WorkflowStoreError;

export interface WorkflowEngine {
  readonly dispatch: (
    runId: RunId,
    event: ExternalEvent,
  ) => Effect.Effect<DispatchResult, WorkflowError>;
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
        changeInspector.inspect(snapshot.runId, snapshot.baseUrl),
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
  turnOwner,
}: {
  readonly runStore: RunStore;
  readonly changeInspector: ChangeInspector;
  readonly turnOwner: TurnOwner;
}): WorkflowEngine => ({
  dispatch: (runId, event) =>
    withTurn(runId, turnOwner, runStore, (lease) =>
        Effect.gen(function* () {
          const persisted = yield* runStore.loadRun(runId);
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
    ),
  getPendingJob: (runId) => runStore.getPendingJob(runId),
  getStatus: (runId) => runStore.getStatus(runId),
});
