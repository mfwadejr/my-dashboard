import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { SecretBox } from "./crypto.js";
import { SCHEMA_VERSION } from "./db.js";

export type CheckStatus = "pass" | "warn" | "fail";
export interface Check { id: string; label: string; status: CheckStatus; detail: string }
export interface VerifyReport {
  kind: "database" | "json";
  /** True when nothing failed. Warnings do not change this. */
  ok: boolean;
  /** True when the file can safely be restored (it opens, is intact and is not from a newer version). */
  restorable: boolean;
  checks: Check[];
  counts: Record<string, number>;
  size: number;
  createdAt: number | null;
  layout: number | null;
  summary: string;
}

const STRUCTURAL = new Set(["sqlite", "integrity", "foreign", "layout", "structure"]);
export const finish = (kind: "database" | "json", checks: Check[], counts: Record<string, number>, size: number, createdAt: number | null, layout: number | null): VerifyReport => {
  const failed = checks.filter(c => c.status === "fail"), warned = checks.filter(c => c.status === "warn");
  const passed = checks.filter(c => c.status === "pass").length;
  return {
    kind, ok: failed.length === 0, restorable: !checks.some(c => c.status === "fail" && STRUCTURAL.has(c.id)), checks, counts, size, createdAt, layout,
    summary: failed.length ? `${failed.length} check(s) failed: ${failed.map(c => c.label).join(", ")}` : `${passed} check(s) passed${warned.length ? `, ${warned.length} warning(s)` : ""}`
  };
};

const SQLITE_MAGIC = "SQLite format 3\0";
export function looksLikeSqlite(file: string): boolean {
  try { return readFileSync(file).subarray(0, 16).toString("latin1") === SQLITE_MAGIC; } catch { return false; }
}

const COUNT_TABLES: Array<[string, string]> = [["tabs", "tabs"], ["groups", "groups"], ["tiles", "tiles"], ["connections", "integrations"], ["cameras", "cameras"], ["accounts", "users"], ["shareLinks", "shares"], ["logLines", "events"]];

/**
 * Checks a database file without touching it: it is copied to a temporary folder and the copy is opened read-only.
 * `tmpRoot` must be a folder this process may write to.
 */
export function verifyDatabaseFile(file: string, box: SecretBox, tmpRoot: string, createdAt?: number | null): VerifyReport {
  const checks: Check[] = [], counts: Record<string, number> = {};
  const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });
  const size = existsSync(file) ? statSync(file).size : 0;
  const when = createdAt ?? (existsSync(file) ? Math.round(statSync(file).mtimeMs) : null);
  if (!size) { add("sqlite", "Opens as a database", "fail", "The file is empty or missing."); return finish("database", checks, counts, size, when, null); }
  if (!looksLikeSqlite(file)) { add("sqlite", "Opens as a database", "fail", "This is not a SQLite database file."); return finish("database", checks, counts, size, when, null); }

  mkdirSync(tmpRoot, { recursive: true });
  const work = mkdtempSync(join(tmpRoot, "verify-"));
  let db: DatabaseSync | null = null;
  let layout: number | null = null;
  try {
    const copy = join(work, "copy.db");
    copyFileSync(file, copy);
    try { db = new DatabaseSync(copy, { readOnly: true }); db.prepare("SELECT COUNT(*) FROM sqlite_master").get(); add("sqlite", "Opens as a database", "pass", "The file opened normally."); }
    catch (error) { add("sqlite", "Opens as a database", "fail", `It could not be opened: ${error instanceof Error ? error.message : error}`); return finish("database", checks, counts, size, when, null); }

    const integrity = (db.prepare("PRAGMA integrity_check").all() as Array<Record<string, string>>).map(r => Object.values(r)[0]);
    if (integrity.length === 1 && integrity[0] === "ok") add("integrity", "Internal consistency", "pass", "SQLite's integrity check found no problems.");
    else add("integrity", "Internal consistency", "fail", `SQLite reported problems: ${integrity.slice(0, 3).join("; ")}`);

    const fk = db.prepare("PRAGMA foreign_key_check").all();
    if (fk.length === 0) add("foreign", "Links between records", "pass", "Every group and tile belongs to something that exists.");
    else add("foreign", "Links between records", "fail", `${fk.length} record(s) point at something that is missing.`);

    try {
      layout = Number((db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string } | undefined)?.v ?? NaN);
      if (!Number.isInteger(layout) || layout < 1) { add("layout", "Database layout version", "fail", "The layout version is missing, so this does not look like a Homebase database."); layout = null; }
      else if (layout > SCHEMA_VERSION) add("layout", "Database layout version", "fail", `Layout ${layout} is from a newer Homebase than this one (it understands up to ${SCHEMA_VERSION}).`);
      else if (layout < SCHEMA_VERSION) add("layout", "Database layout version", "pass", `Layout ${layout}. It is older than the current ${SCHEMA_VERSION} and will be upgraded automatically (with a safety copy) when it is used.`);
      else add("layout", "Database layout version", "pass", `Layout ${layout}, the same as this version.`);
    } catch { add("layout", "Database layout version", "fail", "The layout version could not be read, so this does not look like a Homebase database."); }
    if (layout === null) return finish("database", checks, counts, size, when, null);

    for (const [key, table] of COUNT_TABLES) {
      try { counts[key] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n); } catch { /* older layouts lack some tables */ }
    }
    add("counts", "What it contains", "pass", `${counts.tabs ?? 0} tab(s), ${counts.tiles ?? 0} tile(s), ${counts.connections ?? 0} connection(s), ${counts.cameras ?? 0} camera(s), ${counts.accounts ?? 0} account(s), ${counts.shareLinks ?? 0} share link(s), ${counts.logLines ?? 0} log line(s).`);

    // Saved passwords and keys only open with the encryption key that sealed them.
    let sealed = 0, bad = 0;
    const tryOpen = (v: unknown) => { if (typeof v !== "string" || !v) return; sealed++; try { box.open(v); } catch { bad++; } };
    try { for (const r of db.prepare("SELECT secret FROM integrations").all() as Array<{ secret: string }>) tryOpen(r.secret); } catch { /* table missing */ }
    try { for (const r of db.prepare("SELECT main_url, sub_url FROM cameras").all() as Array<{ main_url: string; sub_url: string }>) { tryOpen(r.main_url); tryOpen(r.sub_url); } } catch { /* table missing */ }
    try { for (const r of db.prepare("SELECT token_sealed FROM shares").all() as Array<{ token_sealed: string }>) tryOpen(r.token_sealed); } catch { /* table missing */ }
    if (sealed === 0) add("secrets", "Saved passwords and keys", "pass", "Nothing in this copy is stored encrypted, so there is nothing to open.");
    else if (bad === 0) add("secrets", "Saved passwords and keys", "pass", `All ${sealed} saved password(s) and key(s) open with this Homebase's encryption key.`);
    else add("secrets", "Saved passwords and keys", "fail", `${bad} of ${sealed} saved password(s) and key(s) do NOT open with this Homebase's encryption key. They were sealed with a different key file; restoring this copy would lose them.`);

    try {
      if (layout >= 4) {
        const n = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
        add("admin", "An administrator exists", n > 0 ? "pass" : "fail", n > 0 ? `${n} active administrator account(s).` : "There is no active administrator, so nobody could sign in after restoring this copy.");
      } else {
        const has = db.prepare("SELECT 1 FROM meta WHERE k = 'admin_hash'").get();
        add("admin", "An administrator exists", has ? "pass" : "warn", has ? "The older single administrator password is present." : "No administrator password is set yet; you would be asked to create one.");
      }
    } catch { add("admin", "An administrator exists", "warn", "The accounts could not be read."); }

    const dateText = when ? new Date(when).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "unknown";
    add("meta", "Date and size", "pass", `Saved ${dateText}, ${(size / 1024).toFixed(size > 1_048_576 ? 0 : 1)} KB.`);
  } catch (error) {
    add("sqlite", "Opens as a database", "fail", `The check itself failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return finish("database", checks, counts, size, when, layout);
}
