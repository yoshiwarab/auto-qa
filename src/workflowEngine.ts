import { Data, Effect } from "effect";
import type {
  ActiveRunExistsError,
  RunBusyError,
  RunNotFoundError,
  RunRecord,
  RunStore,
  TurnOwner,
  WorkflowStoreError,
} from "./runStore.js";

declare const RunIdType: unique symbol;

export type RunId = string & {
  readonly [RunIdType]: "RunId";
};

export const RunId = (value: string): RunId => value as RunId;

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

export class InvalidTransitionError extends Data.TaggedError(
  "InvalidTransitionError",
)<{
  readonly phase: MachinePhase;
  readonly event: MachineEvent["type"];
}> {}

export interface ChangeInspector {
  readonly inspect: (
    runId: RunId,
    baseUrl: URL,
  ) => Effect.Effect<readonly Change[], ChangeInspectionError>;
}

export type StartEvent = {
  readonly type: "start";
  readonly baseUrl: URL;
};

export type ExternalEvent = StartEvent;

type ChangesInspectedEvent = {
  readonly type: "changesInspected";
};

type MachineEvent = ExternalEvent | ChangesInspectedEvent;

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

export type RunPhase = "inspectingChanges" | "awaitingAgent";
type MachinePhase = "idle" | RunPhase;

type MachineSnapshot = {
  readonly runId: RunId;
  readonly phase: MachinePhase;
  readonly baseUrl: URL;
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

export const TRANSITIONS = {
  idle: {
    start: "inspectingChanges",
  },
  inspectingChanges: {
    changesInspected: "awaitingAgent",
  },
  awaitingAgent: {},
} as const;

export const AUTOMATIC_PHASES = {
  inspectingChanges: {
    recoveryPolicy: "rerun",
  },
} as const;

const step = (
  snapshot: MachineSnapshot,
  event: MachineEvent,
): MachineSnapshot => {
  const nextPhase =
    snapshot.phase === "idle" && event.type === "start"
      ? TRANSITIONS.idle.start
      : snapshot.phase === "inspectingChanges" &&
          event.type === "changesInspected"
        ? TRANSITIONS.inspectingChanges.changesInspected
        : undefined;

  if (nextPhase === undefined) {
    throw new InvalidTransitionError({
      phase: snapshot.phase,
      event: event.type,
    });
  }

  return {
    ...snapshot,
    phase: nextPhase,
  };
};

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

const continueAutomaticWork = (
  snapshot: MachineSnapshot,
  runStore: RunStore,
  changeInspector: ChangeInspector,
): Effect.Effect<DispatchResult, WorkflowError> =>
  Effect.gen(function* () {
    if (snapshot.phase !== "inspectingChanges") {
      return yield* Effect.fail(
        new InvalidTransitionError({
          phase: snapshot.phase,
          event: "changesInspected",
        }),
      );
    }

    const changes = yield* changeInspector.inspect(
      snapshot.runId,
      snapshot.baseUrl,
    );
    const next = step(snapshot, { type: "changesInspected" });
    const pendingJob = createGeneratePlanJob(next, changes);
    yield* runStore.completeInspection(snapshot.runId, pendingJob);

    return {
      phase: "awaitingAgent",
      pendingJob,
    };
  });

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
    Effect.acquireUseRelease(
      runStore.acquireTurn(runId, turnOwner),
      () =>
        Effect.gen(function* () {
          const persisted = yield* runStore.loadRun(runId);
          const inspecting =
            persisted === null
              ? step(
                  {
                    runId,
                    phase: "idle",
                    baseUrl: event.baseUrl,
                  },
                  event,
                )
              : yield* recoveredSnapshot(persisted, event);

          if (persisted === null) {
            yield* runStore.startInspection(runId, event.baseUrl);
          }

          return yield* continueAutomaticWork(
            inspecting,
            runStore,
            changeInspector,
          );
        }),
      (lease) => runStore.releaseTurn(lease).pipe(Effect.orDie),
    ),
  getPendingJob: (runId) => runStore.getPendingJob(runId),
  getStatus: (runId) => runStore.getStatus(runId),
});
