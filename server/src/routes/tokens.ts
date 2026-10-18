import type { FastifyInstance } from "fastify";
import { ValidationError } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";
import { INTEGRATION_TYPES } from "../integrations/registry.js";
import { STARTED_AT, versionInfo } from "../version.js";

export function tokenRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access, tokens, store, poller } = d;
  const admin = { preHandler: access.requireAdmin };

  app.get("/api/tokens", admin, async () => tokens.list());

  app.post("/api/tokens", admin, async (request, reply) => {
    try {
      const b = (request.body ?? {}) as { name?: unknown; scope?: unknown };
      const made = tokens.create(b.name, b.scope, access.actor(request));
      logEvent(db, "info", "api", `${access.actor(request)} created the ${made.row.scope === "write" ? "read-write" : "read-only"} API token "${made.row.name}" (${made.row.prefix}…)`);
      return { ...made.row, token: made.token };
    } catch (error) {
      if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/tokens/:id/revoke", admin, async (request, reply) => {
    const t = tokens.get((request.params as { id: string }).id);
    if (!t || !tokens.revoke(t.id)) return reply.code(404).send({ error: "Not found, or already revoked" });
    logEvent(db, "warn", "api", `${access.actor(request)} revoked the API token "${t.name}"`);
    return { ok: true };
  });

  app.delete("/api/tokens/:id", admin, async (request, reply) => {
    const t = tokens.get((request.params as { id: string }).id);
    if (!t || !tokens.remove(t.id)) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "api", `${access.actor(request)} deleted the API token "${t.name}"`);
    return { ok: true };
  });

  /** A small, flat summary meant for other tools such as Home Assistant. Anyone who can see the dashboard (and any API token) can read it. */
  app.get("/api/summary", async () => {
    const connections = store.listIntegrations().map(row => {
      const snap = poller.get(row.id);
      const state = !row.enabled ? "off" : snap?.ok === true ? "up" : snap?.ok === false ? "down" : "unknown";
      return { id: row.id, name: row.name, type: row.type, typeName: INTEGRATION_TYPES[row.type]?.name ?? row.type, state, ms: snap?.ms ?? null, checkedAt: snap?.checkedAt ?? null, error: state === "down" ? snap?.error ?? null : null };
    });
    const count = (s: string) => connections.filter(c => c.state === s).length;
    return { version: versionInfo().version, uptimeS: Math.round((Date.now() - STARTED_AT) / 1000), cameras: store.listCameras().length, connections, counts: { up: count("up"), down: count("down"), off: count("off"), unknown: count("unknown") } };
  });
}
