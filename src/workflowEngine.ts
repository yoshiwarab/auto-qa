import { Effect, Scope } from "effect";
import {
  SqliteRunStore,
  openSqliteRunStore,
} from "./sqliteRunStore.js";

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

export type RunPhase = "awaitingAgent";

export type DispatchResult = {
  readonly phase: RunPhase;
  readonly pendingJob: GeneratePlanJob;
};

export type RunStatus = {
  readonly runId: string;
  readonly phase: RunPhase;
};

export type WorkflowError =
  | ChangeInspectionError
  | import("./sqliteRunStore.js").RunNotFoundError
  | import("./sqliteRunStore.js").WorkflowStoreError;

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

const makeEngine = (
  store: SqliteRunStore,
  changeInspector: ChangeInspector,
): WorkflowEngine => ({
  dispatch: (runId, event) =>
    Effect.gen(function* () {
      yield* store.beginStart(runId, event.baseUrl);
      const changes = yield* changeInspector.inspect(runId, event.baseUrl);
      const job: GeneratePlanJob = {
        schemaVersion: 1,
        id: `${runId}:generate-plan:1`,
        type: "generate-plan",
        runId,
        payload: {
          baseUrl: event.baseUrl.href,
          changes,
        },
      };
      yield* store.completeInspection(runId, job);

      return {
        phase: "awaitingAgent",
        pendingJob: job,
      };
    }),
  getPendingJob: (runId) => store.getPendingJob(runId),
  getStatus: (runId) => store.getStatus(runId),
});

export const createWorkflowEngine = ({
  databasePath,
  changeInspector,
}: {
  readonly databasePath: string;
  readonly changeInspector: ChangeInspector;
}): Effect.Effect<
  WorkflowEngine,
  import("./sqliteRunStore.js").WorkflowStoreError,
  Scope.Scope
> =>
  Effect.map(openSqliteRunStore(databasePath), (store) =>
    makeEngine(store, changeInspector),
  );
