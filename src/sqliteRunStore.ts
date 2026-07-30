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
import type { ScenarioSubmission } from "./planValidation.js";
import { prepareSqliteRunStoreSchema } from "./sqliteRunStoreSchema.js";
import type {
  AttemptRecord,
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
  readonly outcome: string | null;
};

type AttemptRow = {
  readonly scenario_id: string;
  readonly attempt_number: number;
  readonly script_version: number;
  readonly status: "passed" | "failed";
  readonly evidence_path: string;
};

type ScenarioRow = {
  readonly scenario_id: string;
  readonly goal: string;
  readonly preconditions_json: string;
  readonly mutates: number;
  readonly source: string;
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

const asAttemptRows = (value: unknown): readonly AttemptRow[] =>
  value as readonly AttemptRow[];

const asScenarioRows = (value: unknown): readonly ScenarioRow[] =>
  value as readonly ScenarioRow[];

const decodePhase = (phase: string): RunPhase => {
  if (
    phase === "inspectingChanges" ||
    phase === "awaitingAgent" ||
    phase === "executingScenarios" ||
    phase === "reporting" ||
    phase === "completed" ||
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
    : run.phase === "completed"
    ? {
        runId: run.runId,
        phase: run.phase,
        outcome: run.outcome,
        attempts: run.attempts,
      }
    : {
        runId: run.runId,
        phase: run.phase,
      };

export class SqliteRunStore implements RunStore {
  private readonly hasAbandonReason: boolean;
  private readonly hasOutcome: boolean;

  constructor(
    private readonly database: DatabaseSync,
    initialize = true,
  ) {
    const schema = prepareSqliteRunStoreSchema(
      database,
      initialize,
    );
    this.hasAbandonReason = schema.hasAbandonReason;
    this.hasOutcome = schema.hasOutcome;
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
            `SELECT run_id, phase, base_url, ${this.abandonReasonSelection()}, ${this.outcomeSelection()} FROM runs WHERE run_id = ?`,
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
      if (phase === "completed") {
        if (
          row.outcome !== "passed" &&
          row.outcome !== "defects-found" &&
          row.outcome !== "inconclusive"
        ) {
          throw new Error(
            `Persisted completed Run ${row.run_id} has no outcome`,
          );
        }
        return {
          runId: RunId(row.run_id),
          phase,
          baseUrl: new URL(row.base_url),
          outcome: row.outcome,
          attempts: this.readAttempts(RunId(row.run_id)),
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
                `SELECT run_id, phase, base_url, ${this.abandonReasonSelection()}, ${this.outcomeSelection()} FROM runs WHERE phase NOT IN ('abandoned', 'completed') LIMIT 1`,
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

  acceptPlan(
    lease: TurnLease,
    runId: RunId,
    scenarios: readonly ScenarioSubmission[],
  ): Effect.Effect<
    readonly ScenarioSubmission[],
    TurnOwnershipLostError | WorkflowStoreError
  > {
    return Effect.gen(this, function* () {
      yield* this.ownedTransaction(
        lease,
        "accept generate-plan",
        () => {
          scenarios.forEach((scenario, position) => {
            this.database
              .prepare(
                "INSERT INTO scenarios (run_id, scenario_id, position, goal, preconditions_json, mutates) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                runId,
                scenario.id,
                position,
                scenario.goal,
                JSON.stringify(scenario.preconditions),
                scenario.mutates ? 1 : 0,
              );
            this.database
              .prepare(
                "INSERT INTO scenario_scripts (run_id, scenario_id, script_version, source) VALUES (?, ?, 0, ?)",
              )
              .run(runId, scenario.id, scenario.script);
          });
          this.database
            .prepare("DELETE FROM jobs WHERE run_id = ?")
            .run(runId);
          this.database
            .prepare("UPDATE runs SET phase = ? WHERE run_id = ?")
            .run("executingScenarios", runId);
          const first = scenarios[0];
          if (first !== undefined) {
            this.startScenarioOperation(runId, first.id);
          }
        },
      );
      return yield* this.tryStore("read frozen Scenario Scripts", () =>
        asScenarioRows(
          this.database
            .prepare(
              "SELECT scenarios.scenario_id, scenarios.goal, scenarios.preconditions_json, scenarios.mutates, scenario_scripts.source FROM scenarios JOIN scenario_scripts ON scenario_scripts.run_id = scenarios.run_id AND scenario_scripts.scenario_id = scenarios.scenario_id AND scenario_scripts.script_version = 0 WHERE scenarios.run_id = ? ORDER BY scenarios.position",
            )
            .all(runId),
        ).map((row) => ({
          id: row.scenario_id,
          goal: row.goal,
          preconditions: JSON.parse(
            row.preconditions_json,
          ) as readonly string[],
          mutates: row.mutates === 1,
          script: row.source,
        })),
      );
    });
  }

  completeAttempt(
    lease: TurnLease,
    runId: RunId,
    attempt: AttemptRecord,
    nextScenarioId: string | undefined,
  ): Effect.Effect<
    void,
    TurnOwnershipLostError | WorkflowStoreError
  > {
    return this.ownedTransaction(
      lease,
      "complete Scenario Attempt",
      () => {
        this.database
          .prepare(
            "UPDATE operations SET status = 'completed' WHERE operation_id = ?",
          )
          .run(
            `${runId}:execute:${attempt.scenarioId}:${attempt.attemptNumber}`,
          );
        this.database
          .prepare(
            "INSERT INTO attempts (run_id, scenario_id, attempt_number, script_version, status, evidence_path) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            runId,
            attempt.scenarioId,
            attempt.attemptNumber,
            attempt.scriptVersion,
            attempt.status,
            attempt.evidencePath,
          );
        if (nextScenarioId === undefined) {
          this.database
            .prepare("UPDATE runs SET phase = 'reporting' WHERE run_id = ?")
            .run(runId);
          this.database
            .prepare(
              "INSERT INTO operations (operation_id, run_id, kind, status, recovery_policy) VALUES (?, ?, 'write-report', 'started', 'rerun')",
            )
            .run(`${runId}:write-report:1`, runId);
        } else {
          this.startScenarioOperation(runId, nextScenarioId);
        }
      },
    );
  }

  completePassingReport(
    lease: TurnLease,
    runId: RunId,
  ): Effect.Effect<
    void,
    TurnOwnershipLostError | WorkflowStoreError
  > {
    return this.ownedTransaction(
      lease,
      "complete Run report",
      () => {
        this.database
          .prepare(
            "UPDATE operations SET status = 'completed' WHERE operation_id = ?",
          )
          .run(`${runId}:write-report:1`);
        this.database
          .prepare(
            "UPDATE runs SET phase = 'completed', outcome = 'passed' WHERE run_id = ?",
          )
          .run(runId);
      },
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

  private outcomeSelection(): string {
    return this.hasOutcome ? "outcome" : "NULL AS outcome";
  }

  private readAttempts(runId: RunId): readonly AttemptRecord[] {
    return asAttemptRows(
      this.database
        .prepare(
          "SELECT attempts.scenario_id, attempts.attempt_number, attempts.script_version, attempts.status, attempts.evidence_path FROM attempts JOIN scenarios ON scenarios.run_id = attempts.run_id AND scenarios.scenario_id = attempts.scenario_id WHERE attempts.run_id = ? ORDER BY scenarios.position, attempts.attempt_number",
        )
        .all(runId),
    ).map((row) => ({
      scenarioId: row.scenario_id,
      attemptNumber: row.attempt_number,
      scriptVersion: row.script_version,
      status: row.status,
      evidencePath: row.evidence_path,
    }));
  }

  private startScenarioOperation(
    runId: RunId,
    scenarioId: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO operations (operation_id, run_id, kind, status, recovery_policy) VALUES (?, ?, 'execute-scenario', 'started', 'record-interrupted')",
      )
      .run(`${runId}:execute:${scenarioId}:1`, runId);
  }

  private ownedTransaction(
    lease: TurnLease,
    operation: string,
    work: () => void,
  ): Effect.Effect<
    void,
    TurnOwnershipLostError | WorkflowStoreError
  > {
    return Effect.flatMap(
      this.transaction(operation, () => {
        if (!this.ownsTurn(lease)) return false;
        work();
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
