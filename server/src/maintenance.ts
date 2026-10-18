import { existsSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { zonedParts } from "./backup.js";
import { getMeta, logEvent, setMeta, type DB } from "./db.js";
import type { Deps } from "./deps.js";
import { getSettings } from "./settings.js";
import { checkForUpdate } from "./updatecheck.js";

export interface DiskInfo { total: number; free: number; freePct: number; level: "ok" | "low" | "critical" }

/** Free space on the disk that holds the data folder. `low` is worth a look; `critical` can stop the database from writing. */
export function diskInfo(dir: string): DiskInfo | null {
  try {
    const s = statfsSync(dir), total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize);
    if (!total) return null;
    const pct = (free / total) * 100;
    const level = free < 200e6 || pct < 3 ? "critical" : free < 1e9 || pct < 10 ? "low" : "ok";
    return { total, free, freePct: Math.round(pct * 10) / 10, level };
  } catch { return null; }
}

export interface MaintenanceResult {
  ts: number; manual: boolean; ok: boolean; ms: number; integrity: string; foreignKeyProblems: number;
  bytesBefore: number; bytesAfter: number; tables: Array<{ name: string; bytes: number }>; message: string;
}

const fileBytes = (dir: string) => ["homebase.db", "homebase.db-wal"].reduce((n, f) => { const p = join(dir, f); return n + (existsSync(p) ? statSync(p).size : 0); }, 0);

/** Where the space goes, largest first (needs SQLite's dbstat table; empty if not available). */
export function tableSizes(db: DB): Array<{ name: string; bytes: number }> {
  try {
    return (db.prepare(`SELECT CASE WHEN m.tbl_name LIKE 'events_fts%' THEN 'events (search index)' ELSE m.tbl_name END AS name, SUM(d.pgsize) AS bytes
      FROM dbstat d JOIN sqlite_master m ON m.name = d.name GROUP BY 1 ORDER BY bytes DESC`).all() as unknown as Array<{ name: string; bytes: number }>)
      .filter(r => !r.name.startsWith("sqlite_")).slice(0, 8);
  } catch { return []; }
}

export class Maintenance {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private deps: () => Deps) {}

  last(): MaintenanceResult | null { try { return JSON.parse(getMeta(this.deps().db, "maintenance_last") ?? "null"); } catch { return null; } }

  /** Integrity check, then clean up and compact the database. Safe to run any time; it briefly pauses other work. */
  run(manual: boolean): MaintenanceResult {
    const { db, config } = this.deps();
    if (this.running) throw new Error("Maintenance is already running");
    this.running = true;
    const t0 = Date.now(), before = fileBytes(config.dataDir);
    let integrity = "ok", fk = 0, ok = true, message = "";
    try {
      const rows = (db.prepare("PRAGMA integrity_check").all() as Array<Record<string, string>>).map(r => Object.values(r)[0]);
      integrity = rows.length === 1 && rows[0] === "ok" ? "ok" : rows.slice(0, 3).join("; ");
      fk = db.prepare("PRAGMA foreign_key_check").all().length;
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("INSERT INTO events_fts(events_fts) VALUES ('optimize')");
      db.exec("VACUUM");
      db.exec("ANALYZE");
      db.exec("PRAGMA optimize");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) { ok = false; message = error instanceof Error ? error.message : String(error); }
    finally { this.running = false; }
    const after = fileBytes(config.dataDir);
    if (integrity !== "ok" || fk > 0) ok = false;
    const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
    if (!message) message = ok ? `Integrity check passed. The database went from ${mb(before)} to ${mb(after)}.` : integrity !== "ok" ? `The integrity check found problems: ${integrity}. Save a copy now and verify it, then restore the newest good copy if needed.` : `${fk} record(s) point at something that is missing.`;
    const result: MaintenanceResult = { ts: Date.now(), manual, ok, ms: Date.now() - t0, integrity, foreignKeyProblems: fk, bytesBefore: before, bytesAfter: after, tables: tableSizes(db), message };
    setMeta(db, "maintenance_last", JSON.stringify(result));
    logEvent(db, ok ? "info" : "error", "system", `Database maintenance ${manual ? "(started by hand) " : ""}${ok ? "finished" : "found a problem"}: ${message}`);
    return result;
  }

  private due(now: number): boolean {
    const s = getSettings(this.deps().db);
    if (s.maintenance === "off") return false;
    const hour = zonedParts(now, s.timezone).hour;
    if (hour < 3 || hour >= 5) return false; // quiet hours only
    const last = this.last();
    return !last || now - last.ts >= (s.maintenance === "monthly" ? 30 : 7) * 86400_000 - 3600_000;
  }

  /** Every ten minutes: maintenance if due, a disk-space warning at most once a day, and the daily update check when switched on. */
  async tick(now = Date.now()): Promise<void> {
    const d = this.deps(), { db, config } = d;
    try { if (this.due(now)) this.run(false); } catch (error) { logEvent(db, "error", "system", `Database maintenance failed: ${error instanceof Error ? error.message : error}`); }
    const disk = diskInfo(config.dataDir);
    if (disk && disk.level !== "ok" && now - Number(getMeta(db, "disk_warned") ?? 0) > 86400_000) {
      setMeta(db, "disk_warned", String(now));
      logEvent(db, disk.level === "critical" ? "error" : "warn", "system", `The disk that holds Homebase's data is ${disk.level === "critical" ? "almost full" : "getting full"}: ${(disk.free / 1e9).toFixed(1)} GB free (${disk.freePct}%). Remove old database copies or log archives, or free space on the disk.`);
    }
    if (getSettings(db).updateCheck) { try { await checkForUpdate(db, { maxAgeMs: 23 * 3600_000 }); } catch { /* stored as an error note inside */ } }
  }

  start(): void { this.timer = setInterval(() => void this.tick(), 600_000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}
