import type { FastifyInstance } from "fastify";
import { throttleHit } from "../auth.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";
import { diskInfo, tableSizes } from "../maintenance.js";
import { getSettings } from "../settings.js";
import { checkForUpdate, lastUpdateCheck } from "../updatecheck.js";

/** Database maintenance and the optional update check. */
export function systemRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access, maintenance, config } = d;
  const admin = { preHandler: access.requireAdmin };

  app.get("/api/maintenance", admin, async () => ({ last: maintenance.last(), tables: tableSizes(db), disk: diskInfo(config.dataDir), schedule: getSettings(db).maintenance }));

  app.post("/api/maintenance/run", admin, async (request, reply) => {
    if (!throttleHit(db, "maint", 4, 3600_000)) return reply.code(429).send({ error: "Maintenance was just run. Try again later." });
    try { const r = maintenance.run(true); logEvent(db, "info", "system", `${access.actor(request)} ran database maintenance`); return r; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Could not run maintenance" }); }
  });

  app.get("/api/update", admin, async () => ({ enabled: getSettings(db).updateCheck, info: lastUpdateCheck(db) }));

  app.post("/api/update/check", admin, async (request, reply) => {
    if (!getSettings(db).updateCheck) return reply.code(400).send({ error: "Update checks are switched off. Turn them on first; each check sends one request to GitHub." });
    if (!throttleHit(db, "updatecheck", 6, 600_000)) return reply.code(429).send({ error: "Checked a moment ago. Try again in a few minutes." });
    logEvent(db, "info", "system", `${access.actor(request)} checked GitHub for updates`);
    return checkForUpdate(db);
  });
}
