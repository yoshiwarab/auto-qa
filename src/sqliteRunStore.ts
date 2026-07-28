import { DatabaseSync } from "node:sqlite";
import { Effect, Scope } from "effect";
import {
  ActiveRunExistsError,
  RunBusyError,
  RunNotFoundError,
  type RecoveryPolicy,
  type RunRecord,
  type RunStore,
  type TurnLease,
  type TurnOwner,
  TurnOwnershipLostError,
  WorkflowStoreError,
} from "./runStore.js";
import {
  InvalidTransitionError,
  RunId,
  type RunPhase,
} from "./workflowMachine.js";
import { prepareSqliteRunStoreSchema } from "./sqliteRunStoreSchema.js";
import type {
  GeneratePlanJob,
  RunStatus,
} from "./workflowProtocol.js";

type JobRow = {
  readonly job_json: string;
};

type RunRow = {
  readonly run_id: string;
  readonly phase: string;
  readonly base_url: string;
  readonly abandon_reason: string | null;
};

type TurnLockRow = {
  readonly run_id: string;
};

const asJobRow = (value: unknown): JobRow | undefined =>
  value as JobRow | undefined;

const asRunRow = (value: unknown): RunRow | undefined =>
  value as RunRow | undefined;

const asTurnLockRow = (value: unknown): TurnLockRow | undefined =>
  value as TurnLockRow | undefined;

const decodePhase = (phase: string): RunPhase => {
  if (
    phase === "inspectingChanges" ||
    phase === "awaitingAgent" ||
    phase === "abandoned"
  ) {
    return phase;
  }
  throw new Error(`Unsupported persisted Run phase: ${phase}`);
};

const toRunStatus = (run: RunRecord): RunStatus =>
  run.phase === "abandoned"
    ? {
        runId: run.runId,
        phase: run.phase,
        reason: run.reason,
      }
    : {
        runId: run.runId,
        phase: run.phase,
      };

export class SqliteRunStore implements RunStore {
  private readonly hasAbandonReason: boolean;

  constructor(
    private readonly database: DatabaseSync,
    initialize = true,
  ) {
    this.hasAbandonReason = prepareSqliteRunStoreSchema(
      database,
      initialize,
    ).hasAbandonReason;
  }

  close(): void {
    this.database.close();
  }

  acquireTurn(
    runId: RunId,
    owner: TurnOwner,
  ): Effect.Effect<
    TurnLease,
    RunBusyError | WorkflowStoreError
  > {
    return Effect.gen(this, function* () {
      const result = yield* this.tryStore("acquire Turn", () =>
        this.database
          .prepare(
            "INSERT OR IGNORE INTO turn_lock (lock_id, run_id, process_id, process_started_at, ownership_token) VALUES (1, ?, ?, ?, ?)",
          )
          .run(
            runId,
            owner.processId,
            owner.processStartedAt,
            owner.ownershipToken,
          ),
      );
      if (Number(result.changes) === 0) {
        const current = yield* this.tryStore(
          "read Turn owner",
          () =>
            asTurnLockRow(
              this.database
                .prepare(
                  "SELECT run_id FROM turn_lock WHERE lock_id = 1",
                )
                .get(),
            ),
        );
        return yield* Effect.fail(
          new RunBusyError({
            owningRunId: current?.run_id ?? "unknown",
          }),
        );
      }

      return {
        ownershipToken: owner.ownershipToken,
      };
    });
  }

  releaseTurn(
    lease: TurnLease,
  ): Effect.Effect<void, WorkflowStoreError> {
    return Effect.asVoid(
      this.tryStore("release Turn", () =>
        this.database
          .prepare(
            "DELETE FROM turn_lock WHERE lock_id = 1 AND ownership_token = ?",
          )
          .run(lease.ownershipToken),
      ),
    );
  }

  loadRun(
    runId: RunId,
  ): Effect.Effect<RunRecord | null, WorkflowStoreError> {
    return this.tryStore("load Run", () => {
      const row = asRunRow(
        this.database
          .prepare(
            `SELECT run_id, phase, base_url, ${this.abandonReasonSelection()} FROM runs WHERE run_id = ?`,
          )
          .get(runId),
      );
      if (row === undefined) return null;
      const phase = decodePhase(row.phase);
      if (phase === "abandoned") {
        if (row.abandon_reason === null) {
          throw new Error(
            `Persisted abandoned Run ${row.run_id} has no reason`,
          );
        }
        return {
          runId: RunId(row.run_id),
          phase,
          baseUrl: new URL(row.base_url),
          reason: row.abandon_reason,
        };
      }
      return {
        runId: RunId(row.run_id),
        phase,
        baseUrl: new URL(row.base_url),
      };
    });
  }

  startInspection(
    lease: TurnLease,
    runId: RunId,
    baseUrl: URL,
    recoveryPolicy: RecoveryPolicy,
  ): Effect.Effect<
    void,
    | ActiveRunExistsError
    | TurnOwnershipLostError
    | WorkflowStoreError
  > {
    return Effect.gen(this, function* () {
      const result = yield* this.transaction(
        "begin start",
        () => {
          if (!this.ownsTurn(lease)) {
            return { type: "ownership-lost" } as const;
          }
          const activeRun = asRunRow(
            this.database
              .prepare(
                `SELECT run_id, phase, base_url, ${this.abandonReasonSelection()} FROM runs WHERE phase != 'abandoned' LIMIT 1`,
              )
              .get(),
          );
          if (activeRun !== undefined) {
            return {
              type: "active-run",
              runId: activeRun.run_id,
            } as const;
          }

          this.database
            .prepare(
              "INSERT INTO runs (run_id, phase, base_url) VALUES (?, ?, ?)",
            )
            .run(runId, "inspectingChanges", baseUrl.href);
          this.database
            .prepare(
              "INSERT INTO operations (operation_id, run_id, kind, status, recovery_policy) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              `${runId}:inspect-changes:1`,
              runId,
              "inspect-changes",
              "started",
              recoveryPolicy,
            );
          return { type: "started" } as const;
        },
      );

      if (result.type === "ownership-lost") {
        return yield* Effect.fail(
          new TurnOwnershipLostError({
            ownershipToken: lease.ownershipToken,
          }),
        );
      }
      if (result.type === "active-run") {
        return yield* Effect.fail(
          new ActiveRunExistsError({
            activeRunId: result.runId,
          }),
        );
      }
    });
  }

  completeInspection(
    lease: TurnLease,
    runId: RunId,
    job: GeneratePlanJob,
  ): Effect.Effect<
    void,
    TurnOwnershipLostError | WorkflowStoreError
  > {
    return Effect.flatMap(
      this.transaction("complete change inspection", () => {
        if (!this.ownsTurn(lease)) {
          return false;
        }
        this.database
          .prepare(
            "UPDATE operations SET status = ? WHERE operation_id = ?",
          )
          .run("completed", `${runId}:inspect-changes:1`);
        this.database
          .prepare(
            "INSERT INTO jobs (job_id, run_id, job_json) VALUES (?, ?, ?)",
          )
          .run(job.id, runId, JSON.stringify(job));
        this.database
          .prepare("UPDATE runs SET phase = ? WHERE run_id = ?")
          .run("awaitingAgent", runId);
        return true;
      }),
      (ownsTurn) =>
        ownsTurn
          ? Effect.void
          : Effect.fail(
              new TurnOwnershipLostError({
                ownershipToken: lease.ownershipToken,
              }),
            ),
    );
  }

  getPendingJob(
    runId: RunId,
  ): Effect.Effect<GeneratePlanJob | null, WorkflowStoreError> {
    return this.tryStore("read pending Job", () => {
      const row = asJobRow(
        this.database
          .prepare(
            "SELECT jobs.job_json FROM jobs JOIN runs ON runs.run_id = jobs.run_id WHERE jobs.run_id = ? AND runs.phase = 'awaitingAgent'",
          )
          .get(runId),
      );
      return row === undefined
        ? null
        : (JSON.parse(row.job_json) as GeneratePlanJob);
    });
  }

  getStatus(
    runId: RunId,
  ): Effect.Effect<
    RunStatus,
    RunNotFoundError | WorkflowStoreError
  > {
    return Effect.flatMap(this.loadRun(runId), (run) =>
      run === null
        ? Effect.fail(new RunNotFoundError({ runId }))
        : Effect.succeed(toRunStatus(run)),
    );
  }

  abandon(
    lease: TurnLease,
    runId: RunId,
    reason: string,
  ): Effect.Effect<
    RunStatus,
    | RunNotFoundError
    | InvalidTransitionError
    | TurnOwnershipLostError
    | WorkflowStoreError
  > {
    return Effect.gen(this, function* () {
      const result = yield* this.transaction("abandon Run", () => {
        if (!this.ownsTurn(lease)) {
          return { type: "ownership-lost" } as const;
        }
        const row = asRunRow(
          this.database
            .prepare(
              `SELECT run_id, phase, base_url, ${this.abandonReasonSelection()} FROM runs WHERE run_id = ?`,
            )
            .get(runId),
        );
        if (row === undefined) {
          return { type: "not-found" } as const;
        }
        if (row.phase === "abandoned") {
          return { type: "already-terminal" } as const;
        }
        this.database
          .prepare(
            "INSERT INTO events (run_id, type, payload_json) VALUES (?, 'abandon', ?)",
          )
          .run(runId, JSON.stringify({ reason }));
        this.database
          .prepare(
            "UPDATE runs SET phase = 'abandoned', abandon_reason = ? WHERE run_id = ?",
          )
          .run(reason, runId);
        return { type: "abandoned" } as const;
      });
      if (result.type === "ownership-lost") {
        return yield* Effect.fail(
          new TurnOwnershipLostError({
            ownershipToken: lease.ownershipToken,
          }),
        );
      }
      if (result.type === "not-found") {
        return yield* Effect.fail(new RunNotFoundError({ runId }));
      }
      if (result.type === "already-terminal") {
        return yield* Effect.fail(
          new InvalidTransitionError({
            phase: "abandoned",
            event: "abandon",
            allowedEvents: [],
          }),
        );
      }
      return {
        runId,
        phase: "abandoned",
        reason,
      };
    });
  }

  private transaction<Result>(
    operation: string,
    work: () => Result,
  ): Effect.Effect<Result, WorkflowStoreError> {
    return this.tryStore(operation, () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  private ownsTurn(lease: TurnLease): boolean {
    return (
      this.database
        .prepare(
          "SELECT 1 AS owns_turn FROM turn_lock WHERE lock_id = 1 AND ownership_token = ?",
        )
        .get(lease.ownershipToken) !== undefined
    );
  }

  private abandonReasonSelection(): string {
    return this.hasAbandonReason
      ? "abandon_reason"
      : "NULL AS abandon_reason";
  }

  private tryStore<Result>(
    operation: string,
    work: () => Result,
  ): Effect.Effect<Result, WorkflowStoreError> {
    return Effect.try({
      try: work,
      catch: (cause) => new WorkflowStoreError({ operation, cause }),
    });
  }
}

export const openSqliteRunStore = (
  databasePath: string,
  options: { readonly readOnly?: boolean } = {},
): Effect.Effect<RunStore, WorkflowStoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        new SqliteRunStore(
          new DatabaseSync(databasePath, {
            readOnly: options.readOnly ?? false,
          }),
          !(options.readOnly ?? false),
        ),
      catch: (cause) =>
        new WorkflowStoreError({
          operation: "open Run Store",
          cause,
        }),
    }),
    (store) => Effect.sync(() => store.close()),
  );
