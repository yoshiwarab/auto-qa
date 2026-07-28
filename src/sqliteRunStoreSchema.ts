import type { DatabaseSync } from "node:sqlite";

type SqliteRunStoreSchema = {
  readonly hasAbandonReason: boolean;
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
    if (!hasRunColumn(database, "abandon_reason")) {
      database.exec(
        "ALTER TABLE runs ADD COLUMN abandon_reason TEXT",
      );
    }
  }

  return {
    hasAbandonReason: hasRunColumn(database, "abandon_reason"),
  };
};
