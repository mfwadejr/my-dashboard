import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getMeta, setMeta, stampNow, type DB } from "./db.js";
import { getSettings, type Settings } from "./settings.js";

const HOUR = 3600_000, DAY = 86400_000, ARCHIVE_KEEP = 24;
export const ARCHIVE_NAME = /^homebase-log-\d{8}-\d{6}(-[a-z]+)?\.csv$/;

export interface RetentionResult {
  dryRun: boolean;
  /** Graph readings: how many detailed readings were folded into hourly averages (and how many rows that became), then the same for daily. */
  hourly: { from: number; to: number }; daily: { from: number; to: number }; expiredReadings: number;
  /** Log lines removed: by age rules (severity and area) and by the size cap. */
  logByAge: number; logBySize: number;
  archive: string | null;
  /** For callers that only want totals. */
  metrics: number; events: number;
}

/** The three history tiers in days, kept in a sensible order even if old settings do not line up. */
export function historyTiers(s: Settings): { detail: number; hourlyEnd: number; total: number } {
  const detail = Math.max(1, s.historyDetailDays), total = Math.max(s.metricsDays, detail + 2);
  return { detail, hourlyEnd: Math.min(Math.max(s.historyHourlyDays, detail + 1), total - 1), total };
}

/** Builds the SQL that selects log lines that are too old under the severity and per-area rules. */
function ageRule(s: Settings, now: number): { sql: string; args: number[] } {
  const areas = Object.entries(s.logAreaDays);
  const parts: string[] = [], args: number[] = [];
  for (const [area, days] of areas) { parts.push("(source = ? AND ts < ?)"); args.push(area as unknown as number, now - days * DAY); }
  const others = areas.length ? `source NOT IN (${areas.map(() => "?").join(",")}) AND ` : "";
  parts.push(`(${others}((level = 'info' AND ts < ?) OR (level = 'warn' AND ts < ?) OR (level = 'error' AND ts < ?)))`);
  args.push(...areas.map(([a]) => a as unknown as number), now - s.logDays * DAY, now - s.logWarnDays * DAY, now - s.logErrorDays * DAY);
  return { sql: parts.join(" OR "), args };
}

const SIZE_EXPR = "(LENGTH(message) + LENGTH(source) + 48)";

/** The smallest log id that still fits under the size cap (everything older goes), or null when under the cap already. */
function capThreshold(db: DB, capBytes: number): number | null {
  const total = (db.prepare(`SELECT COALESCE(SUM(${SIZE_EXPR}), 0) AS b FROM events`).get() as { b: number }).b;
  if (total <= capBytes) return null;
  const row = db.prepare(`SELECT MIN(id) AS id FROM (SELECT id, SUM(${SIZE_EXPR}) OVER (ORDER BY id DESC) AS run FROM events) WHERE run <= ?`).get(capBytes) as { id: number | null };
  return row.id ?? Number.MAX_SAFE_INTEGER;
}

/** Writes old log lines to a CSV file in <data>/log-archive before they are deleted. */
function archiveRows(db: DB, dataDir: string, tz: string, where: string, args: Array<string | number>): string | null {
  const dir = join(dataDir, "log-archive");
  mkdirSync(dir, { recursive: true });
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "medium" });
  const name = `homebase-log-${stampNow()}.csv`;
  const fd = openSync(join(dir, name), "w");
  let n = 0, buf = "time,level,source,message\n";
  try {
    for (const r of db.prepare(`SELECT ts, level, source, message FROM events WHERE ${where} ORDER BY id`).iterate(...args) as Iterable<{ ts: number; level: string; source: string; message: string }>) {
      buf += `${fmt.format(r.ts)},${r.level},${r.source},"${r.message.replace(/"/g, '""')}"\n`; n++;
      if (buf.length > 65536) { writeSync(fd, buf); buf = ""; }
    }
    writeSync(fd, buf);
  } finally { closeSync(fd); }
  if (n === 0) { try { unlinkSync(join(dir, name)); } catch { /* nothing was written */ } return null; }
  const files = readdirSync(dir).filter(f => ARCHIVE_NAME.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) { try { unlinkSync(join(dir, old)); } catch { /* ignore */ } }
  return name;
}

export function listArchives(dataDir: string): Array<{ name: string; size: number; ts: number }> {
  const dir = join(dataDir, "log-archive");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => ARCHIVE_NAME.test(f)).map(name => { const st = statSync(join(dir, name)); return { name, size: st.size, ts: st.mtimeMs }; }).sort((a, b) => b.ts - a.ts);
}

/**
 * Applies every history and log rule: graph readings are averaged into hourly then daily points as they age and finally dropped;
 * log lines are removed by severity/area age and by the size cap, optionally after being saved to a file.
 * With dryRun nothing changes; the numbers say what would happen.
 */
export function runRetention(db: DB, dataDir: string, opts: { dryRun?: boolean; now?: number } = {}): RetentionResult {
  const now = opts.now ?? Date.now(), dry = Boolean(opts.dryRun), s = getSettings(db), t = historyTiers(s);
  const one = (sql: string, ...a: Array<string | number>) => Number((db.prepare(sql).get(...a) as { n: number }).n);

  // ---- graph history
  const hCut = Math.floor((now - t.detail * DAY) / HOUR) * HOUR;
  const hFrom = one("SELECT COUNT(*) AS n FROM metrics WHERE res = 0 AND ts < ?", hCut);
  const hTo = hFrom ? one("SELECT COUNT(*) AS n FROM (SELECT 1 FROM metrics WHERE res = 0 AND ts < ? GROUP BY instance_id, key, ts / 3600000)", hCut) : 0;
  const dCut = Math.floor((now - t.hourlyEnd * DAY) / DAY) * DAY;
  // Rows the hourly step would create also count toward the daily step when they are old enough.
  const dFrom = one("SELECT COUNT(*) AS n FROM metrics WHERE res = 1 AND ts < ?", dCut);
  const dTo = dFrom ? one("SELECT COUNT(*) AS n FROM (SELECT 1 FROM metrics WHERE res = 1 AND ts < ? GROUP BY instance_id, key, ts / 86400000)", dCut) : 0;
  const expiredCut = now - t.total * DAY;
  let expired = one("SELECT COUNT(*) AS n FROM metrics WHERE ts < ?", expiredCut);

  // ---- log
  const rule = ageRule(s, now);
  const byAge = one(`SELECT COUNT(*) AS n FROM events WHERE ${rule.sql}`, ...rule.args);

  let archive: string | null = null, bySize = 0;
  if (!dry) {
    if (hFrom) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO metrics (instance_id, key, ts, value, res) SELECT instance_id, key, (ts / 3600000) * 3600000, AVG(value), 1 FROM metrics WHERE res = 0 AND ts < ? GROUP BY instance_id, key, ts / 3600000").run(hCut);
        db.prepare("DELETE FROM metrics WHERE res = 0 AND ts < ?").run(hCut);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
    const dNow = one("SELECT COUNT(*) AS n FROM metrics WHERE res = 1 AND ts < ?", dCut);
    if (dNow) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO metrics (instance_id, key, ts, value, res) SELECT instance_id, key, (ts / 86400000) * 86400000, AVG(value), 2 FROM metrics WHERE res = 1 AND ts < ? GROUP BY instance_id, key, ts / 86400000").run(dCut);
        db.prepare("DELETE FROM metrics WHERE res = 1 AND ts < ?").run(dCut);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
    expired = Number(db.prepare("DELETE FROM metrics WHERE ts < ?").run(expiredCut).changes);
  }

  if (!dry) {
    if (byAge && s.logExportBeforePrune) archive = archiveRows(db, dataDir, s.timezone, rule.sql, rule.args);
    db.prepare(`DELETE FROM events WHERE ${rule.sql}`).run(...rule.args);
  }
  // The size cap is checked after the age rules (in a dry run, estimate as if they had run).
  if (s.logMaxMB > 0) {
    const cap = s.logMaxMB * 1_048_576;
    if (dry) {
      const total = (db.prepare(`SELECT COALESCE(SUM(${SIZE_EXPR}), 0) AS b FROM events WHERE NOT (${rule.sql})`).get(...rule.args) as { b: number }).b;
      if (total > cap) bySize = one(`SELECT COUNT(*) AS n FROM (SELECT id, SUM(${SIZE_EXPR}) OVER (ORDER BY id DESC) AS run FROM events WHERE NOT (${rule.sql})) WHERE run > ?`, ...rule.args, cap);
    } else {
      const th = capThreshold(db, cap);
      if (th !== null) {
        bySize = one("SELECT COUNT(*) AS n FROM events WHERE id < ?", th);
        if (bySize && s.logExportBeforePrune) { const f = archiveRows(db, dataDir, s.timezone, "id < ?", [th]); archive = archive ?? f; }
        db.prepare("DELETE FROM events WHERE id < ?").run(th);
      }
    }
  }

  const result: RetentionResult = {
    dryRun: dry, hourly: { from: hFrom, to: hTo }, daily: { from: dFrom, to: dTo }, expiredReadings: expired, logByAge: byAge, logBySize: bySize, archive,
    metrics: Math.max(0, hFrom - hTo) + Math.max(0, dFrom - dTo) + expired, events: byAge + bySize
  };
  if (!dry) setMeta(db, "last_prune", JSON.stringify({ ts: now, ...result }));
  return result;
}

export const lastPrune = (db: DB): (RetentionResult & { ts: number }) | null => { try { return JSON.parse(getMeta(db, "last_prune") ?? "null"); } catch { return null; } };
