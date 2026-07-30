import type { DatabaseSync } from "node:sqlite";

type SqliteRunStoreSchema = {
  readonly hasAbandonReason: boolean;
  readonly hasOutcome: boolean;
  readonly hasJobCompletion: boolean;
  readonly hasPlanLimits: boolean;
};

const runColumns = (
  database: DatabaseSync,
): readonly { readonly name: string }[] =>
  database
    .prepare("PRAGMA table_info(runs)")
    .all() as unknown as readonly { readonly name: string }[];

const hasRunColumn = (
  database: DatabaseSync,
  name: string,
): boolean =>
  runColumns(database).some((column) => column.name === name);

const hasTableColumn = (
  database: DatabaseSync,
  table: string,
  name: string,
): boolean =>
  (
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as readonly { readonly name: string }[]
  ).some((column) => column.name === name);

export const prepareSqliteRunStoreSchema = (
  database: DatabaseSync,
  initialize: boolean,
): SqliteRunStoreSchema => {
  if (initialize) {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        base_url TEXT NOT NULL,
        abandon_reason TEXT,
        outcome TEXT,
        active_work_ms INTEGER NOT NULL DEFAULT 0,
        max_scenarios INTEGER NOT NULL DEFAULT 20,
        scenario_timeout_ms INTEGER NOT NULL DEFAULT 30000,
        active_work_budget_ms INTEGER NOT NULL DEFAULT 300000
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
        job_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        submission_hash TEXT,
        result_json TEXT
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

      CREATE TABLE IF NOT EXISTS scenarios (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        scenario_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        goal TEXT NOT NULL,
        preconditions_json TEXT NOT NULL,
        mutates INTEGER NOT NULL,
        PRIMARY KEY (run_id, scenario_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS scenario_scripts (
        run_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        script_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (run_id, scenario_id, script_version),
        FOREIGN KEY (run_id, scenario_id)
          REFERENCES scenarios(run_id, scenario_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS attempts (
        run_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        script_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        evidence_path TEXT NOT NULL,
        PRIMARY KEY (run_id, scenario_id, attempt_number),
        FOREIGN KEY (run_id, scenario_id)
          REFERENCES scenarios(run_id, scenario_id)
      ) STRICT;
    `);
    if (!hasRunColumn(database, "abandon_reason")) {
      database.exec(
        "ALTER TABLE runs ADD COLUMN abandon_reason TEXT",
      );
    }
    if (!hasRunColumn(database, "outcome")) {
      database.exec("ALTER TABLE runs ADD COLUMN outcome TEXT");
    }
    if (!hasRunColumn(database, "active_work_ms")) {
      database.exec(
        "ALTER TABLE runs ADD COLUMN active_work_ms INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!hasRunColumn(database, "max_scenarios")) {
      database.exec(
        "ALTER TABLE runs ADD COLUMN max_scenarios INTEGER NOT NULL DEFAULT 20",
      );
    }
    if (!hasRunColumn(database, "scenario_timeout_ms")) {
      database.exec(
        "ALTER TABLE runs ADD COLUMN scenario_timeout_ms INTEGER NOT NULL DEFAULT 30000",
      );
    }
    if (!hasRunColumn(database, "active_work_budget_ms")) {
      database.exec(
        "ALTER TABLE runs ADD COLUMN active_work_budget_ms INTEGER NOT NULL DEFAULT 300000",
      );
    }
    if (!hasTableColumn(database, "jobs", "status")) {
      database.exec(
        "ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
      );
    }
    if (!hasTableColumn(database, "jobs", "submission_hash")) {
      database.exec(
        "ALTER TABLE jobs ADD COLUMN submission_hash TEXT",
      );
    }
    if (!hasTableColumn(database, "jobs", "result_json")) {
      database.exec(
        "ALTER TABLE jobs ADD COLUMN result_json TEXT",
      );
    }
  }

  return {
    hasAbandonReason: hasRunColumn(database, "abandon_reason"),
    hasOutcome: hasRunColumn(database, "outcome"),
    hasJobCompletion: hasTableColumn(
      database,
      "jobs",
      "status",
    ),
    hasPlanLimits:
      hasRunColumn(database, "max_scenarios") &&
      hasRunColumn(database, "scenario_timeout_ms") &&
      hasRunColumn(database, "active_work_budget_ms"),
  };
};
