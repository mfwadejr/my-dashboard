import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { checkUserPassword, throttleHit } from "../auth.js";
import { applyBackup, exportBackup, parseBackup, previewBackup, validSnapshotName } from "../backup.js";
import { ValidationError, resetDashboard } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";
import { INTEGRATION_TYPES } from "../integrations/registry.js";
import { getSettings } from "../settings.js";
import { STARTED_AT, versionInfo } from "../version.js";

/** Turns what a person typed into a full-text query: every word must appear, and the last may be a prefix. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  return words && words.length ? words.slice(0, 12).map(w => `"${w}"*`).join(" ") : null;
}

interface LogRow { id: number; ts: number; level: string; source: string; message: string }

function queryLogs(d: Deps, q: Record<string, string | undefined>, max: number) {
  const where: string[] = [], args: Array<string | number> = [];
  const fts = q.q ? ftsQuery(q.q) : null;
  if (q.q && !fts) { where.push("message LIKE ?"); args.push(`%${q.q.slice(0, 80)}%`); }
  if (fts) { where.push("id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)"); args.push(fts); }
  if (q.level && ["info", "warn", "error"].includes(q.level)) { where.push("level = ?"); args.push(q.level); }
  if (q.source) { where.push("source = ?"); args.push(q.source.slice(0, 40)); }
  if (Number(q.since) > 0) { where.push("ts >= ?"); args.push(Number(q.since)); }
  if (Number(q.until) > 0) { where.push("ts <= ?"); args.push(Number(q.until)); }
  if (Number(q.before) > 0) { where.push("id < ?"); args.push(Number(q.before)); }
  const limit = Math.max(1, Math.min(max, Number(q.limit) || 100));
  const rows = d.db.prepare(`SELECT id, ts, level, source, message FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit) as unknown as LogRow[];
  return { rows, limit };
}

export function adminRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access, store, poller, go2rtc, shares, backups, box, config } = d;
  const admin = { preHandler: access.requireAdmin };
  const bad = (reply: any, error: unknown) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
    throw error;
  };

  // ---- status

  app.get("/api/status", admin, async () => {
    const now = Date.now(), since = now - 24 * 3600_000, BUCKETS = 48, span = (now - since) / BUCKETS;
    const connections = store.listIntegrations().map(row => {
      const snap = poller.get(row.id);
      const pts = db.prepare("SELECT ts, value FROM metrics WHERE instance_id = ? AND key = '_up' AND ts >= ? ORDER BY ts").all(row.id, since) as unknown as Array<{ ts: number; value: number }>;
      const strip: Array<number | null> = Array(BUCKETS).fill(null);
      for (const p of pts) { const i = Math.min(BUCKETS - 1, Math.floor((p.ts - since) / span)); strip[i] = strip[i] === 0 || p.value === 0 ? 0 : 1; }
      const up = pts.length ? Math.round((pts.filter(p => p.value === 1).length / pts.length) * 1000) / 10 : null;
      return {
        id: row.id, name: row.name, type: row.type, typeName: INTEGRATION_TYPES[row.type]?.name ?? row.type, enabled: Boolean(row.enabled),
        ok: snap?.ok ?? null, lastOk: snap?.ts ?? null, checkedAt: snap?.checkedAt ?? null, error: snap?.error ?? null, ms: snap?.ms ?? null, uptime24h: up, strip
      };
    });
    const relay = await go2rtc.status();
    return { version: versionInfo(), uptimeS: Math.round((now - STARTED_AT) / 1000), connections, cameras: store.listCameras().length, relay, publicPort: config.publicPort && config.publicPort > 0 ? config.publicPort : null, clients: d.hub.size };
  });

  // ---- log

  app.get("/api/logs", admin, async request => {
    const { rows, limit } = queryLogs(d, request.query as Record<string, string | undefined>, 500);
    const sources = (db.prepare("SELECT DISTINCT source FROM events ORDER BY source").all() as unknown as Array<{ source: string }>).map(r => r.source);
    return { rows, sources, more: rows.length === limit };
  });

  app.get("/api/logs/export", admin, async (request, reply) => {
    const { rows } = queryLogs(d, request.query as Record<string, string | undefined>, 5000);
    const tz = getSettings(db).timezone;
    const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "medium" });
    const csv = ["time,level,source,message", ...rows.map(r => [fmt.format(r.ts), r.level, r.source, `"${r.message.replace(/"/g, '""')}"`].join(","))].join("\n");
    return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="homebase-log.csv"').send(csv);
  });

  // The older endpoint stays for anything that still calls it.
  app.get("/api/events", async request => {
    if (!access.viewer(request)) return [];
    const limit = Math.max(1, Math.min(200, Number((request.query as any)?.limit ?? 50) || 50));
    return db.prepare("SELECT id, ts, level, source, message FROM events ORDER BY id DESC LIMIT ?").all(limit);
  });

  // ---- data: sizes, history, danger zone

  const dbBytes = () => ["", "-wal"].reduce((n, s) => { const f = join(config.dataDir, "homebase.db" + s); return n + (existsSync(f) ? statSync(f).size : 0); }, 0);

  app.get("/api/data/stats", admin, async () => {
    const one = (sql: string) => (db.prepare(sql).get() as { n: number; t?: number | null });
    const m = db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS t FROM metrics").get() as { n: number; t: number | null };
    const snaps = backups.list();
    return {
      dbBytes: dbBytes(), metricsRows: m.n, oldestMetric: m.t, eventRows: one("SELECT COUNT(*) AS n FROM events").n,
      snapshots: snaps.length, snapshotBytes: snaps.reduce((n, s) => n + s.size, 0),
      key: { source: box.source, file: box.source === "file" ? box.keyFile : null }
    };
  });

  app.post("/api/data/prune", admin, async request => {
    const r = poller.prune();
    logEvent(db, "info", "backup", `${access.actor(request)} cleared old history: ${r.metrics} reading(s) and ${r.events} log line(s) removed`);
    return r;
  });

  app.post("/api/data/clear-metrics", admin, async (request) => {
    const id = typeof (request.body as any)?.id === "string" ? (request.body as any).id : "";
    const n = Number((id ? db.prepare("DELETE FROM metrics WHERE instance_id = ?").run(id) : db.prepare("DELETE FROM metrics").run()).changes);
    logEvent(db, "info", "backup", `${access.actor(request)} cleared the history graphs ${id ? `for ${store.getIntegration(id)?.name ?? "a connection"}` : "for every connection"}`);
    return { ok: true, removed: n };
  });

  app.post("/api/data/clear-logs", admin, async request => {
    db.exec("DELETE FROM events");
    logEvent(db, "warn", "backup", `${access.actor(request)} cleared the log`);
    return { ok: true };
  });

  app.post("/api/data/reset-layout", admin, async request => {
    try { backups.create("before-reset"); } catch { /* the reset is still what was asked for */ }
    resetDashboard(db);
    logEvent(db, "warn", "backup", `${access.actor(request)} reset the dashboard layout to the starter layout (a safety copy was saved first)`);
    return { ok: true };
  });

  // ---- export / import (JSON)

  app.post("/api/backup/export", admin, async (request, reply) => {
    const pass = typeof (request.body as any)?.passphrase === "string" ? (request.body as any).passphrase : "";
    if (pass && (pass.length < 8 || pass.length > 200)) return reply.code(400).send({ error: "Use a passphrase of at least 8 characters" });
    const file = exportBackup(d, pass);
    logEvent(db, "info", "backup", `${access.actor(request)} exported a backup${pass ? " including passwords and keys (protected by a passphrase)" : " without passwords and keys"}`);
    return file;
  });

  const importBody = { bodyLimit: 8_000_000, preHandler: access.requireAdmin };
  app.post("/api/backup/import", importBody, async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>;
    try {
      const file = parseBackup(b.file);
      const opts = { mode: b.mode === "merge" ? "merge" as const : "replace" as const, passphrase: typeof b.passphrase === "string" ? b.passphrase : "", skipSecrets: Boolean(b.skipSecrets) };
      if (b.dryRun) return { preview: previewBackup(d, file, opts) };
      if (opts.passphrase && !throttleHit(db, "importpass", 10, 300_000)) return reply.code(429).send({ error: "Too many tries. Wait a few minutes." });
      return { result: await applyBackup(d, file, opts, access.actor(request)) };
    } catch (error) { return bad(reply, error); }
  });

  // ---- automatic snapshots (real copies of the SQLite file)

  app.get("/api/backup/snapshots", admin, async () => backups.list());

  app.post("/api/backup/snapshots", admin, async (request, reply) => {
    try {
      const made = backups.create("manual");
      backups.prune(getSettings(db).backupKeep);
      logEvent(db, "info", "backup", `${access.actor(request)} saved a backup copy of the database (${Math.max(1, Math.round(made.size / 1024))} KB)`);
      return made;
    } catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : "Could not save the backup" }); }
  });

  app.get("/api/backup/snapshots/:name", admin, async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!validSnapshotName(name) || !existsSync(join(backups.dir, name))) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "backup", `${access.actor(request)} downloaded the backup copy ${name}`);
    return reply.header("Content-Type", "application/octet-stream").header("Content-Disposition", `attachment; filename="${name}"`).send(createReadStream(join(backups.dir, name)));
  });

  app.delete("/api/backup/snapshots/:name", admin, async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!backups.remove(name)) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "backup", `${access.actor(request)} deleted the backup copy ${name}`);
    return { ok: true };
  });

  // ---- the encryption key file (asks for the password again)

  app.post("/api/backup/secret-key", admin, async (request, reply) => {
    const p = access.principal(request);
    if (p?.kind !== "user") return reply.code(401).send({ error: "Sign in required" });
    if (!throttleHit(db, `key:${p.user.id}`, 5, 300_000)) return reply.code(429).send({ error: "Too many attempts. Wait a few minutes." });
    const password = (request.body as any)?.password;
    if (typeof password !== "string" || !(await checkUserPassword(db, p.user.id, password))) return reply.code(401).send({ error: "That password is not right" });
    const key = box.exportKey();
    if (!key) return reply.code(400).send({ error: "The key comes from the HOMEBASE_SECRET_KEY setting, so there is no key file to download" });
    logEvent(db, "warn", "backup", `${access.actor(request)} downloaded the encryption key file`);
    return { key };
  });

  void shares; void store;
}
