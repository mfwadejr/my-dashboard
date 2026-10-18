import { spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { throttleHit } from "../auth.js";
import { nextSlot, validSnapshotName, verifyJsonBackup } from "../backup.js";
import { ValidationError } from "../dashboard.js";
import { logEvent, stampNow } from "../db.js";
import type { Deps } from "../deps.js";
import { createComplete, looksLikeComplete, readComplete, verifyComplete } from "../complete.js";
import { checkImage } from "../icons.js";
import { getSettings } from "../settings.js";
import { looksLikeSqlite, verifyDatabaseFile, type VerifyReport } from "../verify.js";

const MAX_DB = 2_000_000_000, MAX_JSON = 60_000_000;

/** Restore, verify, upload and network-copy routes. */
export function backupOpsRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access, backups, destinations, config } = d;
  const admin = { preHandler: access.requireAdmin };
  const bad = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
    throw error;
  };
  const tmpRoot = backups.tmp;

  /** Saves the uploaded file to a private temporary folder and runs `use` on it. The folder is always removed afterwards. */
  async function withUpload<T>(request: any, limit: number, use: (file: string, fields: Record<string, string>, name: string) => Promise<T> | T): Promise<T> {
    const data = await request.file({ limits: { fileSize: limit, files: 1 } });
    if (!data) throw new ValidationError("No file was received");
    mkdirSync(tmpRoot, { recursive: true });
    const dir = join(tmpRoot, `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir);
    try {
      const target = join(dir, "upload.bin");
      await pipeline(data.file, createWriteStream(target));
      if (data.file.truncated) throw new ValidationError("That file is too large");
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.fields ?? {})) { const f = v as { type?: string; value?: unknown }; if (f?.type === "field" && typeof f.value === "string") fields[k] = f.value; }
      return await use(target, fields, String(data.filename ?? "file").slice(0, 120));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ---- verify

  app.post("/api/backup/snapshots/:name/verify", admin, async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!validSnapshotName(name) || !existsSync(join(backups.dir, name))) return reply.code(404).send({ error: "Not found" });
    const report = backups.verify(name);
    logEvent(db, report.ok ? "info" : "error", "backup", `${access.actor(request)} verified the copy ${name}: ${report.summary}`);
    return report;
  });

  app.post("/api/backup/verify-file", admin, async (request, reply) => {
    try {
      const report = await withUpload<VerifyReport>(request, MAX_DB, async (file, fields, filename) => {
        const size = statSync(file).size;
        if (looksLikeComplete(file)) {
          const open = await readComplete(file, tmpRoot);
          try {
            const r = verifyComplete(d, open, size, tmpRoot);
            logEvent(db, r.ok ? "info" : "error", "backup", `${access.actor(request)} verified an uploaded Complete backup (${filename}): ${r.summary}`);
            return r;
          } finally { rmSync(open.dir, { recursive: true, force: true }); }
        }
        if (looksLikeSqlite(file)) {
          const r = verifyDatabaseFile(file, d.box, tmpRoot, Date.now(), { hasIcon: n => Boolean(d.icons.file(n)) });
          logEvent(db, r.ok ? "info" : "error", "backup", `${access.actor(request)} verified an uploaded database file (${filename}): ${r.summary}`);
          return r;
        }
        if (size > MAX_JSON) throw new ValidationError("This is neither a Homebase database copy nor a backup file");
        let raw: unknown;
        try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new ValidationError("This is neither a Homebase database copy nor a backup file"); }
        const pass = fields.passphrase ?? "";
        if (pass && !throttleHit(db, "verifypass", 10, 300_000)) throw new ValidationError("Too many tries. Wait a few minutes.");
        const r = verifyJsonBackup(d, raw, pass, size);
        logEvent(db, r.ok ? "info" : "error", "backup", `${access.actor(request)} verified an uploaded backup file (${filename}): ${r.summary}`);
        return r;
      });
      return report;
    } catch (error) { return bad(reply, error); }
  });

  /** One download: the database and every saved icon it uses. */
  app.get("/api/backup/complete", admin, async (request, reply) => {
    if (!throttleHit(db, "complete", 8, 3600_000)) return reply.code(429).send({ error: "Too many Complete backups in a short time. Try again later." });
    try {
      const made = await createComplete(d);
      logEvent(db, "info", "backup", `${access.actor(request)} downloaded a Complete backup (${Math.max(1, Math.round(made.size / 1024))} KB)`);
      const stream = createReadStream(made.file);
      stream.on("close", () => rmSync(made.dir, { recursive: true, force: true }));
      return reply.header("Content-Type", "application/gzip").header("Content-Disposition", `attachment; filename="${made.name}"`).header("Content-Length", made.size).send(stream);
    } catch (error) { return reply.code(500).send({ error: `The Complete backup could not be made (${error instanceof Error ? error.message : error}).` }); }
  });

  // ---- add a database copy that came from somewhere else

  app.post("/api/backup/snapshots/upload", admin, async (request, reply) => {
    try {
      return await withUpload(request, MAX_DB, async (file, _fields, filename) => {
        if (looksLikeComplete(file)) {
          const open = await readComplete(file, tmpRoot);
          try {
            const report = verifyComplete(d, open, statSync(file).size, tmpRoot);
            if (!report.restorable) throw new ValidationError(report.checks.find(c => c.status === "fail")?.detail ?? "That backup is damaged");
            mkdirSync(backups.dir, { recursive: true });
            let name = `homebase-${stampNow()}-uploaded.db`;
            for (let n = 0; existsSync(join(backups.dir, name)); n++) name = `homebase-${stampNow()}-uploaded-${"abcdefghij"[n % 10]}.db`;
            copyFileSync(open.dbFile, join(backups.dir, name));
            // The icons go in now (those already here are kept), so restoring the database later finds them.
            let icons = 0;
            for (const [n, buf] of open.icons) {
              try { checkImage(buf, ["svg", "png", "jpg", "gif", "webp"]); const target = d.icons.usedPath(`used/${n}`); if (!existsSync(target)) { mkdirSync(d.icons.usedDir, { recursive: true }); writeFileSync(target, buf); icons++; } } catch { /* skipped: not a safe image */ }
            }
            backups.verify(name);
            logEvent(db, "info", "backup", `${access.actor(request)} added a Complete backup (${filename}): the database copy is in the list as ${name}, ${icons} icon(s) were put back`);
            return { name, report, icons };
          } finally { rmSync(open.dir, { recursive: true, force: true }); }
        }
        if (!looksLikeSqlite(file)) throw new ValidationError("That is not a Homebase database copy or Complete backup");
        const report = verifyDatabaseFile(file, d.box, tmpRoot, Date.now(), { hasIcon: n => Boolean(d.icons.file(n)) });
        if (!report.restorable) throw new ValidationError(report.checks.find(c => c.status === "fail")?.detail ?? "That copy is damaged");
        mkdirSync(backups.dir, { recursive: true });
        let name = `homebase-${stampNow()}-uploaded.db`;
        for (let n = 0; existsSync(join(backups.dir, name)); n++) name = `homebase-${stampNow()}-uploaded-${"abcdefghij"[n % 10]}.db`;
        copyFileSync(file, join(backups.dir, name));
        backups.verify(name);
        logEvent(db, "info", "backup", `${access.actor(request)} added the database copy ${filename} to the list as ${name}`);
        return { name, report };
      });
    } catch (error) { return bad(reply, error); }
  });

  // ---- restore a copy: verify, safety copy, queue the swap, restart

  app.post("/api/backup/snapshots/:name/restore", admin, async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!validSnapshotName(name) || !existsSync(join(backups.dir, name))) return reply.code(404).send({ error: "Not found" });
    const body = (request.body ?? {}) as { force?: boolean };
    const report = backups.verify(name);
    if (!report.restorable) return reply.code(400).send({ error: `This copy cannot be restored: ${report.checks.find(c => c.status === "fail")?.detail ?? "it is damaged"}`, report });
    if (!report.ok && !body.force) return reply.code(409).send({ error: "This copy has problems. Review the checks, then confirm if you still want to restore it.", report });
    let safety: { name: string };
    try { safety = backups.create("before-restore"); }
    catch (error) { return reply.code(500).send({ error: `A safety copy of the current database could not be saved, so nothing was changed (${error instanceof Error ? error.message : error}).` }); }
    try {
      const part = join(config.dataDir, "restore-pending.db.part");
      copyFileSync(join(backups.dir, name), part);
      writeFileSync(join(config.dataDir, "restore-pending.json"), JSON.stringify({ from: name, by: access.actor(request), at: Date.now() }));
      renameSync(part, join(config.dataDir, "restore-pending.db"));
    } catch (error) { return reply.code(500).send({ error: `The copy could not be put in place (${error instanceof Error ? error.message : error}). Nothing was changed.` }); }
    logEvent(db, "warn", "backup", `${access.actor(request)} started a restore from ${name}. The current database was saved as ${safety.name}. Homebase is restarting.`);
    setTimeout(() => d.restart(), 700).unref();
    return { ok: true, restarting: true, safetyCopy: safety.name, report };
  });

  // ---- schedule

  app.get("/api/backup/schedule", admin, async () => {
    const s = getSettings(db);
    const newest = backups.list().find(x => x.auto)?.ts ?? null;
    return { enabled: s.autoBackup, nextAt: s.autoBackup ? nextSlot(Date.now(), s, newest) : null, lastAt: newest };
  });

  // ---- network destinations

  app.get("/api/backup/destinations", admin, async () => ({ items: destinations.list(), smbAvailable: smbAvailable() }));

  app.post("/api/backup/destinations", admin, async (request, reply) => {
    try {
      const made = destinations.create((request.body ?? {}) as Record<string, unknown>);
      logEvent(db, "info", "backup", `${access.actor(request)} added the backup destination "${made.name}" (${made.kind.toUpperCase()} ${made.host})`);
      return made;
    } catch (error) { return bad(reply, error); }
  });

  app.put("/api/backup/destinations/:id", admin, async (request, reply) => {
    try {
      const made = destinations.update((request.params as { id: string }).id, (request.body ?? {}) as Record<string, unknown>);
      logEvent(db, "info", "backup", `${access.actor(request)} changed the backup destination "${made.name}"`);
      return made;
    } catch (error) { return bad(reply, error); }
  });

  app.delete("/api/backup/destinations/:id", admin, async (request, reply) => {
    const id = (request.params as { id: string }).id, was = destinations.get(id);
    if (!was || !destinations.remove(id)) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "backup", `${access.actor(request)} removed the backup destination "${was.name}"`);
    return { ok: true };
  });

  app.post("/api/backup/destinations/:id/test", admin, async (request, reply) => {
    if (!throttleHit(db, "desttest", 20, 300_000)) return reply.code(429).send({ error: "Too many tests. Wait a few minutes." });
    try {
      const id = (request.params as { id: string }).id;
      const r = await destinations.test(id);
      logEvent(db, r.ok ? "info" : "warn", "backup", `${access.actor(request)} tested the backup destination "${destinations.get(id)?.name}": ${r.message}`);
      return r;
    } catch (error) { return bad(reply, error); }
  });

  /** Sends the newest copy (or a chosen one) now. */
  app.post("/api/backup/destinations/:id/send", admin, async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id, want = (request.body as { name?: string } | undefined)?.name;
      const all = backups.list();
      const pick = want ? all.find(x => x.name === want) : all[0];
      if (!pick) return reply.code(404).send({ error: want ? "That copy was not found" : "There are no copies yet. Save one first." });
      return await destinations.send(id, join(backups.dir, pick.name), pick.name, access.actor(request));
    } catch (error) { return bad(reply, error); }
  });
}

let smbChecked: boolean | null = null;
function smbAvailable(): boolean {
  if (smbChecked === null) { try { smbChecked = spawnSync("smbclient", ["--version"], { timeout: 4000 }).status === 0; } catch { smbChecked = false; } }
  return smbChecked;
}
