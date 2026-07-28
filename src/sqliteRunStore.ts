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

export class SqliteRunStore implements RunStore {
  constructor(
    private readonly database: DatabaseSync,
    initialize = true,
  ) {
    if (initialize) {
      this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        base_url TEXT NOT NULL,
        abandon_reason TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        recovery_policy TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
        job_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS turn_lock (
        lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1),
        run_id TEXT NOT NULL,
        process_id INTEGER NOT NULL,
        process_started_at TEXT NOT NULL,
        ownership_token TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      `);
      const runColumns = this.database
        .prepare("PRAGMA table_info(runs)")
        .all() as unknown as readonly { readonly name: string }[];
      if (!runColumns.some((column) => column.name === "abandon_reason")) {
        this.database.exec(
          "ALTER TABLE runs ADD COLUMN abandon_reason TEXT",
        );
      }
    }
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
            "SELECT run_id, phase, base_url, abandon_reason FROM runs WHERE run_id = ?",
          )
          .get(runId),
      );
      return row === undefined
        ? null
        : {
            runId: RunId(row.run_id),
            phase: decodePhase(row.phase),
            baseUrl: new URL(row.base_url),
            ...(row.abandon_reason === null
              ? {}
              : { reason: row.abandon_reason }),
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
                "SELECT run_id, phase, base_url, abandon_reason FROM runs WHERE phase != 'abandoned' LIMIT 1",
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
          .prepare("SELECT job_json FROM jobs WHERE run_id = ?")
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
        : Effect.succeed({
            runId: run.runId,
            phase: run.phase,
            ...(run.reason === undefined
              ? {}
              : { reason: run.reason }),
          }),
    );
  }

  abandon(
    lease: TurnLease,
    runId: RunId,
    reason: string,
    phase: "abandoned",
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
              "SELECT run_id, phase, base_url, abandon_reason FROM runs WHERE run_id = ?",
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
        phase,
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
