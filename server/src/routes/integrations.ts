import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { COOKIE, sessionValid } from "../auth.js";
import type { DB } from "../db.js";
import type { Hub } from "../hub.js";
import { readSeries, type Poller } from "../poller.js";
import type { Store } from "../store.js";
import { IntegrationError, normalizeUrl } from "../integrations/http.js";
import { INTEGRATION_TYPES, publicTypeInfo } from "../integrations/registry.js";

function parseInput(body: any, existing?: { type: string }) {
  const type = existing?.type ?? String(body?.type ?? "");
  if (!INTEGRATION_TYPES[type]) throw new IntegrationError("Choose an app type");
  const name = String(body?.name ?? "").trim() || INTEGRATION_TYPES[type].name;
  if (name.length > 60) throw new IntegrationError("The name is too long");
  const url = normalizeUrl(String(body?.url ?? ""));
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const intervalSeconds = Math.max(5, Math.min(3600, Math.round(Number(body?.intervalSeconds ?? 15)) || 15));
  return { type, name, url, apiKey, intervalSeconds, enabled: body?.enabled === undefined ? true : Boolean(body.enabled) };
}

export function integrationRoutes(app: FastifyInstance, db: DB, store: Store, poller: Poller, hub: Hub, requireAuth: preHandlerAsyncHookHandler): void {
  app.get("/api/integration-types", async () => publicTypeInfo());

  // Viewers see names and status only. Addresses are shown to the signed-in admin.
  app.get("/api/integrations", async request => {
    const admin = sessionValid(db, request.cookies[COOKIE]);
    return store.listIntegrations().map(row => ({
      id: row.id, type: row.type, name: row.name, enabled: Boolean(row.enabled),
      ...(admin ? { url: row.url, intervalSeconds: row.interval_s, hasKey: Boolean(row.secret) } : {})
    }));
  });

  app.post("/api/integrations", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const input = parseInput(request.body);
      if (!input.apiKey) throw new IntegrationError("An API key is required");
      const id = store.createIntegration(input);
      poller.reload(id);
      return { id };
    } catch (error) {
      if (error instanceof IntegrationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.put("/api/integrations/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = store.getIntegration(id);
    if (!row) return reply.code(404).send({ error: "Not found" });
    try {
      const input = parseInput(request.body, row);
      store.updateIntegration(id, { name: input.name, url: input.url, apiKey: input.apiKey || undefined, intervalSeconds: input.intervalSeconds, enabled: input.enabled });
      poller.reload(id);
      return { ok: true };
    } catch (error) {
      if (error instanceof IntegrationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/integrations/:id", { preHandler: requireAuth }, async request => {
    const { id } = request.params as { id: string };
    store.deleteIntegration(id);
    poller.reload(id);
    return { ok: true };
  });

  /** Test before saving ({type,url,apiKey}) or test a saved one ({id}, optionally with a changed url/key). */
  app.post("/api/integrations/test", { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as any;
    try {
      const saved = body.id ? store.getIntegration(String(body.id)) : undefined;
      if (body.id && !saved) return reply.code(404).send({ error: "Not found" });
      const type = saved?.type ?? String(body.type ?? "");
      const impl = INTEGRATION_TYPES[type];
      if (!impl) return reply.code(400).send({ error: "Choose an app type" });
      const url = normalizeUrl(String(body.url || saved?.url || ""));
      const apiKey = (typeof body.apiKey === "string" && body.apiKey.trim()) || (saved ? store.apiKeyOf(saved) : "");
      if (!apiKey) return { ok: false, message: "Enter the API key" };
      return await impl.test({ url, apiKey });
    } catch (error) {
      if (error instanceof IntegrationError) return { ok: false, message: error.message };
      throw error;
    }
  });

  app.post("/api/integrations/:id/actions/:action", { preHandler: requireAuth }, async (request, reply) => {
    const { id, action } = request.params as { id: string; action: string };
    const row = store.getIntegration(id);
    const impl = row && INTEGRATION_TYPES[row.type];
    const run = impl?.actions?.[action];
    if (!row || !run) return reply.code(404).send({ error: "Unknown action" });
    try {
      await run({ url: row.url, apiKey: store.apiKeyOf(row) }, (request.body ?? {}) as Record<string, unknown>);
      void poller.run(id); // refresh the tile right away
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Action failed" });
    }
  });

  app.get("/api/data", async () => Object.fromEntries(poller.all().map(s => [s.id, s])));

  app.get("/api/metrics/:id/:key", async request => {
    const { id, key } = request.params as { id: string; key: string };
    const minutes = Math.max(5, Math.min(14 * 1440, Number((request.query as any)?.minutes ?? 360) || 360));
    return readSeries(db, id, key, minutes);
  });

  app.get("/api/events", async request => {
    const limit = Math.max(1, Math.min(200, Number((request.query as any)?.limit ?? 50) || 50));
    return db.prepare("SELECT id, ts, level, source, message FROM events ORDER BY id DESC LIMIT ?").all(limit);
  });

  app.get("/api/stream", async (request, reply) => {
    reply.hijack();
    hub.add(reply.raw, poller.all().map(s => ["snapshot", s] as [string, unknown]));
  });
}
