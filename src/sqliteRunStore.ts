import { DatabaseSync } from "node:sqlite";
import { Effect, Scope } from "effect";
import {
  ActiveRunExistsError,
  RunBusyError,
  RunNotFoundError,
  type RecoveryPolicy,
  type JobSubmissionState,
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
import type { PlanLimits } from "./planValidation.js";
import { prepareSqliteRunStoreSchema } from "./sqliteRunStoreSchema.js";
import type {
  AttemptRecord,
  ClassifyFindingsJob,
  CompletedDispatchResult,
  GeneratePlanJob,
  Job,
  RunStatus,
} from "./workflowProtocol.js";
import {
  type ProcessIdentity,
  type ProcessIdentityError,
} from "./processIdentity.js";
import { makeNodeProcessIdentity } from "./nodeProcessIdentity.js";
import {
  decodeProcessIncarnation,
  encodeProcessIncarnation,
} from "./persistedProcessIncarnation.js";

type JobRow = {
  readonly job_json: string;
};

type JobSubmissionRow = {
  readonly status: "pending" | "accepted" | "completed";
  readonly submission_hash: string | null;
  readonly result_json: string | null;
};

type RunRow = {
  readonly run_id: string;
  readonly phase: string;
  readonly base_url: string;
  readonly abandon_reason: string | null;
  readonly outcome: string | null;
  readonly max_scenarios: number;
  readonly scenario_timeout_ms: number;
  readonly active_work_budget_ms: number;
};

type AttemptRow = {
  readonly scenario_id: string;
  readonly attempt_number: number;
  readonly script_version: number;
  readonly status: "passed" | "failed" | "interrupted";
  readonly evidence_path: string | null;
};

type InterruptedScenarioRow = {
  readonly operation_id: string;
  readonly scenario_id: string;
  readonly attempt_number: number;
  readonly script_version: number;
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
  readonly process_id: number;
  readonly process_started_at: string;
  readonly ownership_token: string;
};

const asJobRow = (value: unknown): JobRow | undefined =>
  value as JobRow | undefined;

const asJobSubmissionRow = (
  value: unknown,
): JobSubmissionRow | undefined =>
  value as JobSubmissionRow | undefined;

const asRunRow = (value: unknown): RunRow | undefined =>
  value as RunRow | undefined;

const asTurnLockRow = (value: unknown): TurnLockRow | undefined =>
  value as TurnLockRow | undefined;

const asAttemptRows = (value: unknown): readonly AttemptRow[] =>
  value as readonly AttemptRow[];

const asScenarioRows = (value: unknown): readonly ScenarioRow[] =>
  value as readonly ScenarioRow[];

const asInterruptedScenarioRow = (
  value: unknown,
): InterruptedScenarioRow | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("operation_id" in value) ||
    typeof value.operation_id !== "string" ||
    !("scenario_id" in value) ||
    typeof value.scenario_id !== "string" ||
    !("attempt_number" in value) ||
    typeof value.attempt_number !== "number" ||
    !("script_version" in value) ||
    typeof value.script_version !== "number"
  ) {
    return undefined;
  }
  return {
    operation_id: value.operation_id,
    scenario_id: value.scenario_id,
    attempt_number: value.attempt_number,
    script_version: value.script_version,
  };
};

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
  private readonly hasJobCompletion: boolean;
  private readonly hasPlanLimits: boolean;

  constructor(
    private readonly database: DatabaseSync,
    initialize = true,
    private readonly processIdentity = makeNodeProcessIdentity(),
  ) {
    const schema = prepareSqliteRunStoreSchema(
      database,
      initialize,
    );
    this.hasAbandonReason = schema.hasAbandonReason;
    this.hasOutcome = schema.hasOutcome;
    this.hasJobCompletion = schema.hasJobCompletion;
    this.hasPlanLimits = schema.hasPlanLimits;
  }

  close(): void {
    this.database.close();
  }

  acquireTurn(
    runId: RunId,
    owner: TurnOwner,
  ): Effect.Effect<
    TurnLease,
    ProcessIdentityError | RunBusyError | WorkflowStoreError
  > {
    return Effect.gen(this, function* () {
      let recoveredStaleOwner = false;
      const result = yield* this.tryStore("acquire Turn", () =>
        this.database
          .prepare(
            "INSERT OR IGNORE INTO turn_lock (lock_id, run_id, process_id, process_started_at, ownership_token) VALUES (1, ?, ?, ?, ?)",
          )
          .run(
            runId,
            owner.processId,
            encodeProcessIncarnation(owner.processIncarnation),
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
                  "SELECT run_id, process_id, process_started_at, ownership_token FROM turn_lock WHERE lock_id = 1",
                )
                .get(),
            ),
        );
        if (current === undefined) {
          return yield* Effect.fail(
            new RunBusyError({ owningRunId: "unknown" }),
          );
        }
        const persistedIncarnation = yield* this.tryStore(
          "decode Turn owner",
          () =>
            decodeProcessIncarnation(
              current.process_started_at,
            ),
        );
        const recordedOwnerIsLive =
          yield* this.processIdentity.isRunning(
            persistedIncarnation.format === "legacy"
              ? { processId: current.process_id }
              : {
                  processId: current.process_id,
                  processIncarnation:
                    persistedIncarnation.incarnation,
                },
          );
        if (recordedOwnerIsLive) {
          return yield* Effect.fail(
            new RunBusyError({ owningRunId: current.run_id }),
          );
        }

        const takeover = yield* this.transaction(
          "take over stale Turn",
          () => {
            const deleted = this.database
              .prepare(
                "DELETE FROM turn_lock WHERE lock_id = 1 AND ownership_token = ?",
              )
              .run(current.ownership_token);
            if (Number(deleted.changes) === 0) return false;
            this.database
              .prepare(
                "INSERT INTO turn_lock (lock_id, run_id, process_id, process_started_at, ownership_token) VALUES (1, ?, ?, ?, ?)",
              )
              .run(
                runId,
                owner.processId,
                encodeProcessIncarnation(owner.processIncarnation),
                owner.ownershipToken,
              );
            return true;
          },
        );
        if (!takeover) {
          return yield* Effect.fail(
            new RunBusyError({ owningRunId: current.run_id }),
          );
        }
        recoveredStaleOwner = true;
      }

      return {
        ownershipToken: owner.ownershipToken,
        recoveredStaleOwner,
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
            `SELECT run_id, phase, base_url, ${this.abandonReasonSelection()}, ${this.outcomeSelection()}, ${this.planLimitsSelection()} FROM runs WHERE run_id = ?`,
          )
          .get(runId),
      );
      if (row === undefined) return null;
      const phase = decodePhase(row.phase);
      const planLimits = {
        maxScenarios: row.max_scenarios,
        scenarioTimeoutMs: row.scenario_timeout_ms,
        activeWorkBudgetMs: row.active_work_budget_ms,
      };
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
          planLimits,
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
          planLimits,
        };
      }
      return {
        runId: RunId(row.run_id),
        phase,
        baseUrl: new URL(row.base_url),
        planLimits,
      };
    });
  }

  startInspection(
    lease: TurnLease,
    runId: RunId,
    baseUrl: URL,
    recoveryPolicy: RecoveryPolicy,
    planLimits: PlanLimits,
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
                `SELECT run_id, phase, base_url, ${this.abandonReasonSelection()}, ${this.outcomeSelection()}, ${this.planLimitsSelection()} FROM runs WHERE phase NOT IN ('abandoned', 'completed') LIMIT 1`,
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
              "INSERT INTO runs (run_id, phase, base_url, max_scenarios, scenario_timeout_ms, active_work_budget_ms) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              runId,
              "inspectingChanges",
              baseUrl.href,
              planLimits.maxScenarios,
              planLimits.scenarioTimeoutMs,
              planLimits.activeWorkBudgetMs,
            );
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
    submissionHash: string,
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
            .prepare(
              "UPDATE jobs SET status = 'accepted', submission_hash = ? WHERE run_id = ?",
            )
            .run(submissionHash, runId);
          this.database
            .prepare("UPDATE runs SET phase = ? WHERE run_id = ?")
            .run("executingScenarios", runId);
          const first = scenarios[0];
          if (first !== undefined) {
            this.startScenarioOperation(runId, first.id, 1, 0);
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
          this.startScenarioOperation(runId, nextScenarioId, 1, 0);
        }
      },
    );
  }

  recordInterruptedScenario(
    lease: TurnLease,
    runId: RunId,
  ): Effect.Effect<
    ClassifyFindingsJob | null,
    TurnOwnershipLostError | WorkflowStoreError
  > {
    return Effect.flatMap(
      this.transaction("record interrupted Scenario Attempt", () => {
        if (!this.ownsTurn(lease)) {
          return { type: "ownership-lost" } as const;
        }
        const interrupted = asInterruptedScenarioRow(
          this.database
            .prepare(
              `SELECT operation_id, scenario_id, attempt_number, script_version
               FROM operations
               WHERE run_id = ?
                 AND kind = 'execute-scenario'
                 AND status = 'started'
                 AND recovery_policy = 'record-interrupted'
                 AND scenario_id IS NOT NULL
                 AND attempt_number IS NOT NULL
                 AND script_version IS NOT NULL
               LIMIT 1`,
            )
            .get(runId),
        );
        if (interrupted === undefined) {
          return { type: "none" } as const;
        }

        const attemptNumber = interrupted.attempt_number;
        const findingId = `${runId}:${interrupted.scenario_id}:${attemptNumber}`;
        const summary =
          "Scenario execution was interrupted before a result was durably recorded";
        const finding = {
          id: findingId,
          scenarioId: interrupted.scenario_id,
          attemptNumber,
          scriptVersion: interrupted.script_version,
          mechanicalStatus: "interrupted",
          cause: "interrupted",
          summary,
          evidenceBundle: null,
        } as const;
        const job: ClassifyFindingsJob = {
          schemaVersion: 1,
          id: `${runId}:classify-findings:1`,
          type: "classify-findings",
          runId,
          payload: { findings: [finding] },
        };

        this.database
          .prepare(
            "UPDATE operations SET status = 'interrupted' WHERE operation_id = ?",
          )
          .run(interrupted.operation_id);
        this.database
          .prepare(
            "INSERT INTO attempts (run_id, scenario_id, attempt_number, script_version, status, evidence_path) VALUES (?, ?, ?, ?, 'interrupted', NULL)",
          )
          .run(
            runId,
            interrupted.scenario_id,
            attemptNumber,
            interrupted.script_version,
          );
        this.database
          .prepare(
            "INSERT INTO findings (finding_id, run_id, scenario_id, attempt_number, script_version, mechanical_status, cause, summary, evidence_path) VALUES (?, ?, ?, ?, ?, 'interrupted', 'interrupted', ?, NULL)",
          )
          .run(
            findingId,
            runId,
            interrupted.scenario_id,
            attemptNumber,
            interrupted.script_version,
            summary,
          );
        this.database
          .prepare(
            "INSERT INTO jobs (job_id, run_id, job_json) VALUES (?, ?, ?)",
          )
          .run(job.id, runId, JSON.stringify(job));
        this.database
          .prepare(
            "INSERT INTO events (run_id, type, payload_json) VALUES (?, 'scenarioExecutionInterrupted', ?)",
          )
          .run(
            runId,
            JSON.stringify({
              scenarioId: interrupted.scenario_id,
              attemptNumber,
              scriptVersion: interrupted.script_version,
            }),
          );
        this.database
          .prepare("UPDATE runs SET phase = 'awaitingAgent' WHERE run_id = ?")
          .run(runId);
        return { type: "recorded", job } as const;
      }),
      (result) =>
        result.type === "ownership-lost"
          ? Effect.fail(
              new TurnOwnershipLostError({
                ownershipToken: lease.ownershipToken,
              }),
            )
          : Effect.succeed(
              result.type === "recorded" ? result.job : null,
            ),
    );
  }

  completePassingReport(
    lease: TurnLease,
    runId: RunId,
    result: CompletedDispatchResult,
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
        this.database
          .prepare(
            "UPDATE jobs SET status = 'completed', result_json = ? WHERE run_id = ?",
          )
          .run(JSON.stringify(result), runId);
      },
    );
  }

  getJobSubmission(
    runId: RunId,
    jobId: string,
  ): Effect.Effect<
    JobSubmissionState | null,
    WorkflowStoreError
  > {
    return this.tryStore("read Job submission", () => {
      if (!this.hasJobCompletion) return null;
      const row = asJobSubmissionRow(
        this.database
          .prepare(
            "SELECT status, submission_hash, result_json FROM jobs WHERE job_id = ? AND run_id = ?",
          )
          .get(jobId, runId),
      );
      return row === undefined
        ? null
        : {
            status: row.status,
            submissionHash: row.submission_hash,
            result:
              row.result_json === null
                ? null
                : (JSON.parse(
                    row.result_json,
                  ) as CompletedDispatchResult),
          };
    });
  }

  getActiveWorkMs(
    runId: RunId,
  ): Effect.Effect<number, WorkflowStoreError> {
    return this.tryStore("read active-work budget", () => {
      const row = this.database
        .prepare(
          "SELECT active_work_ms FROM runs WHERE run_id = ?",
        )
        .get(runId) as
        | { readonly active_work_ms: number }
        | undefined;
      return row?.active_work_ms ?? 0;
    });
  }

  recordActiveWorkMs(
    lease: TurnLease,
    runId: RunId,
    elapsedMs: number,
  ): Effect.Effect<
    void,
    TurnOwnershipLostError | WorkflowStoreError
  > {
    return this.ownedTransaction(
      lease,
      "record active-work budget",
      () => {
        this.database
          .prepare(
            "UPDATE runs SET active_work_ms = active_work_ms + ? WHERE run_id = ?",
          )
          .run(Math.max(0, Math.ceil(elapsedMs)), runId);
      },
    );
  }

  getPendingJob(
    runId: RunId,
  ): Effect.Effect<Job | null, WorkflowStoreError> {
    return this.tryStore("read pending Job", () => {
      const row = asJobRow(
        this.database
          .prepare(
            `SELECT jobs.job_json FROM jobs JOIN runs ON runs.run_id = jobs.run_id WHERE jobs.run_id = ? AND runs.phase = 'awaitingAgent'${this.hasJobCompletion ? " AND jobs.status = 'pending'" : ""}`,
          )
          .get(runId),
      );
      return row === undefined
        ? null
        : (JSON.parse(row.job_json) as Job);
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

  private planLimitsSelection(): string {
    return this.hasPlanLimits
      ? "max_scenarios, scenario_timeout_ms, active_work_budget_ms"
      : "20 AS max_scenarios, 30000 AS scenario_timeout_ms, 300000 AS active_work_budget_ms";
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
      evidencePath:
        row.evidence_path === null || row.evidence_path === ""
          ? null
          : row.evidence_path,
    }));
  }

  private startScenarioOperation(
    runId: RunId,
    scenarioId: string,
    attemptNumber: number,
    scriptVersion: number,
  ): void {
    this.database
      .prepare(
        "INSERT INTO operations (operation_id, run_id, kind, status, recovery_policy, scenario_id, attempt_number, script_version) VALUES (?, ?, 'execute-scenario', 'started', 'record-interrupted', ?, ?, ?)",
      )
      .run(
        `${runId}:execute:${scenarioId}:${attemptNumber}`,
        runId,
        scenarioId,
        attemptNumber,
        scriptVersion,
      );
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
  options: {
    readonly readOnly?: boolean;
    readonly processIdentity?: ProcessIdentity;
  } = {},
): Effect.Effect<RunStore, WorkflowStoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        new SqliteRunStore(
          new DatabaseSync(databasePath, {
            readOnly: options.readOnly ?? false,
          }),
          !(options.readOnly ?? false),
          options.processIdentity,
        ),
      catch: (cause) =>
        new WorkflowStoreError({
          operation: "open Run Store",
          cause,
        }),
    }),
    (store) => Effect.sync(() => store.close()),
  );
