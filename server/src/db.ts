import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, readFileSync, statSync, unlinkSync } from "node:fs";
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
  `ALTER TABLE integrations ADD COLUMN insecure_tls INTEGER NOT NULL DEFAULT 0;`,
  /* 3: free tile placement. x/y are NULL until the browser assigns a spot (old dashboards are placed to match how they looked). */
  `ALTER TABLE tiles ADD COLUMN x INTEGER; ALTER TABLE tiles ADD COLUMN y INTEGER; ALTER TABLE groups ADD COLUMN pack INTEGER NOT NULL DEFAULT 0;`,
  /* 4: accounts and roles, share links, persisted login throttle, searchable log */
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL,
    pass_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  INSERT INTO users (id, username, role, pass_hash, created_at)
    SELECT 'u-admin', 'admin', 'admin', v, CAST(strftime('%s','now') AS INTEGER) * 1000 FROM meta WHERE k = 'admin_hash';
  DELETE FROM meta WHERE k = 'admin_hash';
  ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN ua TEXT NOT NULL DEFAULT '';
  UPDATE sessions SET user_id = 'u-admin', last_seen = created_at;
  CREATE TABLE throttle (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL);
  CREATE TABLE shares (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, cameras TEXT NOT NULL DEFAULT '[]',
    token_hash TEXT NOT NULL UNIQUE, token_sealed TEXT NOT NULL, pin_hash TEXT NOT NULL DEFAULT '',
    expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    last_used INTEGER, views INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX events_ts ON events(ts);
  CREATE VIRTUAL TABLE events_fts USING fts5(message, source, content='events', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, message, source) VALUES (new.id, new.message, new.source);
  END;
  CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, message, source) VALUES ('delete', old.id, old.message, old.source);
  END;
  INSERT INTO events_fts(events_fts) VALUES ('rebuild');
  `,
  /* 5: two-factor sign-in, API tokens, idle timeout, graph history resolution (0 = every reading, 1 = hourly average, 2 = daily average) */
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN recovery TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE sessions ADD COLUMN last_active INTEGER NOT NULL DEFAULT 0;
  UPDATE sessions SET last_active = last_seen;
  ALTER TABLE metrics ADD COLUMN res INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX metrics_res_ts ON metrics(res, ts);
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, scope TEXT NOT NULL,
    created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT '', last_used INTEGER, last_ip TEXT NOT NULL DEFAULT '',
    uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0
  );
  `,
  /* 6: icons. Every kind of thing can carry a picture: icon is the saved file (icons/used/...), icon_ref remembers which library icon it came from. icon_index is the searchable list of the three libraries. */
  `
  ALTER TABLE integrations ADD COLUMN icon TEXT NOT NULL DEFAULT ''; ALTER TABLE integrations ADD COLUMN icon_ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE cameras ADD COLUMN icon TEXT NOT NULL DEFAULT ''; ALTER TABLE cameras ADD COLUMN icon_ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN icon TEXT NOT NULL DEFAULT ''; ALTER TABLE users ADD COLUMN icon_ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE api_tokens ADD COLUMN icon TEXT NOT NULL DEFAULT ''; ALTER TABLE api_tokens ADD COLUMN icon_ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE tabs ADD COLUMN icon TEXT NOT NULL DEFAULT ''; ALTER TABLE tabs ADD COLUMN icon_ref TEXT NOT NULL DEFAULT '';
  CREATE TABLE icon_index (
    source TEXT NOT NULL, slug TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'svg', formats TEXT NOT NULL DEFAULT 'svg',
    label TEXT NOT NULL, search_text TEXT NOT NULL, content_hash TEXT NOT NULL DEFAULT '',
    mirrored INTEGER NOT NULL DEFAULT 0, removed_at INTEGER, synced_at INTEGER NOT NULL,
    PRIMARY KEY (source, slug)
  );
  CREATE INDEX icon_index_slug ON icon_index(slug);
  `,
  /* 7: the address a browser opens for a connection (may differ from the one the server uses) and whether it opens inside Homebase. */
  `
  ALTER TABLE integrations ADD COLUMN open_url TEXT NOT NULL DEFAULT ''; ALTER TABLE integrations ADD COLUMN open_mode TEXT NOT NULL DEFAULT 'tab';
`
];

/** Exposed for tests that need to build an older database. */
export const _MIGRATIONS: readonly string[] = MIGRATIONS;

/** The database layout number this version understands. */
export const SCHEMA_VERSION = MIGRATIONS.length;

const pad = (n: number) => String(n).padStart(2, "0");
export const stampNow = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** A consistent copy of the whole database (VACUUM INTO is safe while the app is running). */
export function snapshotInto(db: DB, dir: string, label = ""): { name: string; size: number } {
  mkdirSync(dir, { recursive: true });
  const base = `homebase-${stampNow()}${label ? `-${label}` : ""}`;
  let name = `${base}.db`;
  for (let n = 0; existsSync(join(dir, name)); n++) name = `${base}-${"abcdefghijklmnopqrstuvwxyz"[n % 26]}.db`;
  db.exec(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`);
  return { name, size: statSync(join(dir, name)).size };
}

export interface PendingRestore { from: string; by: string; at: number }

/** If a restore was requested before the last shutdown, put the chosen copy in place now, while nothing has the database open. */
export function applyPendingRestore(dataDir: string): PendingRestore | null {
  const pending = join(dataDir, "restore-pending.db"), marker = join(dataDir, "restore-pending.json");
  if (!existsSync(pending)) return null;
  let info: PendingRestore = { from: "a database copy", by: "an administrator", at: Date.now() };
  try { info = { ...info, ...JSON.parse(readFileSync(marker, "utf8")) }; } catch { /* the marker is only for the log */ }
  const live = join(dataDir, "homebase.db");
  for (const ext of ["-wal", "-shm"]) { try { unlinkSync(live + ext); } catch { /* not there */ } }
  renameSync(pending, live);
  try { unlinkSync(marker); } catch { /* already gone */ }
  return info;
}

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true });
  const restored = applyPendingRestore(dataDir);
  const db = new DatabaseSync(join(dataDir, "homebase.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const current = Number(getMeta(db, "schema_version") ?? 0);
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`This data folder was written by a newer Homebase (database layout ${current}; this version understands up to ${SCHEMA_VERSION}). Nothing was changed. Update Homebase to the newer version, or restore an older database copy.`);
  }
  let upgradeCopy = "";
  if (current > 0 && current < SCHEMA_VERSION) {
    // An existing database is about to change shape: keep a copy first, and do not go on without one.
    try { upgradeCopy = snapshotInto(db, join(dataDir, "backups"), "before-upgrade").name; }
    catch (error) { db.close(); throw new Error(`Homebase needs to upgrade the database but could not save a safety copy first (${error instanceof Error ? error.message : error}). Nothing was changed.`); }
  }
  migrate(db);
  if (upgradeCopy) logEvent(db, "info", "system", `The database was upgraded from layout ${current} to ${SCHEMA_VERSION}. A safety copy was saved first as ${upgradeCopy}`);
  if (restored) logEvent(db, "warn", "backup", `The database was restored from ${restored.from} (requested by ${restored.by})`);
  return db;
}

function migrate(db: DB): void {
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

export type LogLevel = "info" | "warn" | "error";

// How much gets written is a setting ("quiet", "normal", "detailed"). It is read often, so keep it for a few seconds.
let verbosityCache: { db: DB; at: number; value: string } | null = null;
export function verbosity(db: DB): string {
  const now = Date.now();
  if (verbosityCache && verbosityCache.db === db && now - verbosityCache.at < 5000) return verbosityCache.value;
  let value = "normal";
  try { value = String(JSON.parse(getMeta(db, "settings") ?? "{}").logVerbosity ?? "normal"); } catch { /* use the default */ }
  verbosityCache = { db, at: now, value };
  return value;
}
export const forgetVerbosity = () => { verbosityCache = null; };

/**
 * Log sources: security, settings, connection, camera, share, backup, system, api. Messages are plain sentences meant to be read and searched by people.
 * `quiet` keeps only warnings, errors and security notes. `detail` lines are written only in "detailed" mode.
 */
export function logEvent(db: DB, level: LogLevel, source: string, message: string, opts: { detail?: boolean } = {}): void {
  try {
    const v = verbosity(db);
    if (opts.detail && v !== "detailed") return;
    if (v === "quiet" && level === "info" && source !== "security") return;
    db.prepare("INSERT INTO events (ts, level, source, message) VALUES (?, ?, ?, ?)").run(Date.now(), level, source, message.slice(0, 500));
  }
  catch { /* logging must never break the request that triggered it */ }
}
