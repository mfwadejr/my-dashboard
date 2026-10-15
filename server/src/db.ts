import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type DB = DatabaseSync;

/** Append-only list: never edit an old migration, add a new one. */
const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE tabs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL
  );
  CREATE TABLE groups (
    id TEXT PRIMARY KEY, tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '', layout TEXT NOT NULL DEFAULT 'free',
    collapsed INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL
  );
  CREATE TABLE tiles (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    type TEXT NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, position INTEGER NOT NULL,
    config TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE integrations (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
    secret TEXT NOT NULL DEFAULT '', interval_s INTEGER NOT NULL DEFAULT 15,
    enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  );
  CREATE TABLE cameras (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, main_url TEXT NOT NULL, sub_url TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE metrics (
    instance_id TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL
  );
  CREATE INDEX metrics_lookup ON metrics(instance_id, key, ts);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL,
    source TEXT NOT NULL, message TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  `,
  `ALTER TABLE integrations ADD COLUMN insecure_tls INTEGER NOT NULL DEFAULT 0;`
];

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "homebase.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const current = Number(getMeta(db, "schema_version") ?? 0);
  for (let i = current; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      setMeta(db, "schema_version", String(i + 1));
    });
  }
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT v FROM meta WHERE k = ?").get(key) as { v: string } | undefined;
  return row?.v;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function logEvent(db: DB, level: "info" | "warn" | "error", source: string, message: string): void {
  db.prepare("INSERT INTO events (ts, level, source, message) VALUES (?, ?, ?, ?)").run(Date.now(), level, source, message.slice(0, 500));
}
