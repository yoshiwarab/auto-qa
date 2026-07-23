import { DatabaseSync } from "node:sqlite";
import { Data, Effect, Scope } from "effect";
import type {
  GeneratePlanJob,
  RunId,
  RunStatus,
} from "./workflowEngine.js";

export class WorkflowStoreError extends Data.TaggedError(
  "WorkflowStoreError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{
  readonly runId: string;
}> {}

type JobRow = {
  readonly job_json: string;
};

type StatusRow = {
  readonly run_id: string;
  readonly phase: string;
};

const asJobRow = (value: unknown): JobRow | undefined =>
  value as JobRow | undefined;

const asStatusRow = (value: unknown): StatusRow | undefined =>
  value as StatusRow | undefined;

export class SqliteRunStore {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        base_url TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
        job_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  beginStart(
    runId: RunId,
    baseUrl: URL,
  ): Effect.Effect<void, WorkflowStoreError> {
    return this.transaction("begin start", () => {
      this.database
        .prepare(
          "INSERT INTO runs (run_id, phase, base_url) VALUES (?, ?, ?)",
        )
        .run(runId, "inspectingChanges", baseUrl.href);
      this.database
        .prepare(
          "INSERT INTO operations (operation_id, run_id, kind, status) VALUES (?, ?, ?, ?)",
        )
        .run(
          `${runId}:inspect-changes:1`,
          runId,
          "inspect-changes",
          "started",
        );
    });
  }

  completeInspection(
    runId: RunId,
    job: GeneratePlanJob,
  ): Effect.Effect<void, WorkflowStoreError> {
    return this.transaction("complete change inspection", () => {
      this.database
        .prepare("UPDATE operations SET status = ? WHERE operation_id = ?")
        .run("completed", `${runId}:inspect-changes:1`);
      this.database
        .prepare(
          "INSERT INTO jobs (job_id, run_id, job_json) VALUES (?, ?, ?)",
        )
        .run(job.id, runId, JSON.stringify(job));
      this.database
        .prepare("UPDATE runs SET phase = ? WHERE run_id = ?")
        .run("awaitingAgent", runId);
    });
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
  ): Effect.Effect<RunStatus, WorkflowStoreError | RunNotFoundError> {
    return Effect.flatMap(
      this.tryStore("read Run status", () =>
        asStatusRow(
          this.database
            .prepare("SELECT run_id, phase FROM runs WHERE run_id = ?")
            .get(runId),
        ),
      ),
      (row) =>
        row === undefined
          ? Effect.fail(new RunNotFoundError({ runId }))
          : Effect.succeed({
              runId: row.run_id,
              phase: row.phase as RunStatus["phase"],
            }),
    );
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
): Effect.Effect<SqliteRunStore, WorkflowStoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => new SqliteRunStore(new DatabaseSync(databasePath)),
      catch: (cause) =>
        new WorkflowStoreError({
          operation: "open Run Store",
          cause,
        }),
    }),
    (store) => Effect.sync(() => store.close()),
  );
