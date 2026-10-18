import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { DB } from "../db.js";
import type { Access } from "../access.js";
import { logEvent } from "../db.js";
import type { Hub } from "../hub.js";
import { readSeries, type Poller } from "../poller.js";
import type { Store } from "../store.js";
import type { LiveSampler } from "../live.js";
import { RELEASES, buildCalendar, fetchPoster, type Release } from "../calendar.js";
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
  const insecureTls = Boolean(body?.insecureTls);
  return { type, name, url, apiKey, intervalSeconds, insecureTls, enabled: body?.enabled === undefined ? true : Boolean(body.enabled) };
}

export function integrationRoutes(app: FastifyInstance, db: DB, store: Store, poller: Poller, hub: Hub, requireAuth: preHandlerAsyncHookHandler, live: LiveSampler, access: Access, version: string): void {
  app.get("/api/integration-types", async () => publicTypeInfo());

  // Viewers see names and status only. Addresses are shown to the signed-in admin.
  app.get("/api/integrations", async request => {
    const p = access.principal(request); const admin = p?.kind === "user" && p.user.role === "admin";
    return store.listIntegrations().map(row => ({
      id: row.id, type: row.type, name: row.name, enabled: Boolean(row.enabled),
      ...(admin ? { url: row.url, intervalSeconds: row.interval_s, hasKey: Boolean(row.secret), insecureTls: Boolean(row.insecure_tls) } : {})
    }));
  });

  app.post("/api/integrations", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const input = parseInput(request.body);
      if (!input.apiKey) throw new IntegrationError("An API key is required");
      const id = store.createIntegration(input);
      poller.reload(id);
      logEvent(db, "info", "connection", `${access.actor(request)} added the connection "${input.name}" (${INTEGRATION_TYPES[input.type].name})`);
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
      store.updateIntegration(id, { name: input.name, url: input.url, apiKey: input.apiKey || undefined, intervalSeconds: input.intervalSeconds, enabled: input.enabled, insecureTls: input.insecureTls });
      poller.reload(id);
      logEvent(db, "info", "connection", `${access.actor(request)} changed the connection "${input.name}"${input.enabled ? "" : " (switched off)"}`);
      return { ok: true };
    } catch (error) {
      if (error instanceof IntegrationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/integrations/:id", { preHandler: requireAuth }, async request => {
    const { id } = request.params as { id: string };
    const gone = store.getIntegration(id);
    store.deleteIntegration(id);
    poller.reload(id);
    if (gone) logEvent(db, "info", "connection", `${access.actor(request)} deleted the connection "${gone.name}"`);
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
      return await impl.test({ url, apiKey, insecureTls: body.insecureTls === undefined ? Boolean(saved?.insecure_tls) : Boolean(body.insecureTls) });
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
      const out = await run(store.ctxOf(row), (request.body ?? {}) as Record<string, unknown>) as { message?: unknown } | null | undefined;
      void poller.run(id); // refresh the tile right away
      return { ok: true, ...(typeof out?.message === "string" ? { message: out.message } : {}) };
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

  // Fast samples for live graphs. Viewers can read them, like the rest of the tile data.
  app.get("/api/integrations/:id/live", async (request, reply) => {
    const { id } = request.params as { id: string };
    const since = Number((request.query as any)?.since ?? 0) || 0;
    const out = live.read(id, since);
    return out ?? reply.code(404).send({ error: "This connection has no live data" });
  });

  // One calendar across any number of Sonarr and Radarr connections. Viewers can read it, like the rest of the tile data.
  app.get("/api/calendar", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const ids = String(q.ids ?? "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 6);
    const start = new Date(String(q.start ?? "")), end = new Date(String(q.end ?? ""));
    if (!ids.length) return reply.code(400).send({ error: "Choose at least one connection" });
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime() - start.getTime() > 70 * 86400_000) return reply.code(400).send({ error: "Choose a date range of up to 70 days" });
    const release = (RELEASES.has(String(q.release)) ? q.release : "digital") as Release;
    return buildCalendar(store, ids, start, end, release);
  });

  app.get("/api/media-image/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const path = String((request.query as any)?.p ?? "");
    try {
      const img = await fetchPoster(store, id, path);
      if (!img) return reply.code(404).send({ error: "No such image" });
      return reply.header("Content-Type", img.type).header("Cache-Control", "private, max-age=86400").send(img.body);
    } catch { return reply.code(502).send({ error: "Could not load the image" }); }
  });

  app.get("/api/stream", async (request, reply) => {
    reply.hijack();
    hub.add(reply.raw, [["hello", { build: version }], ...poller.all().map(s => ["snapshot", s] as [string, unknown])]);
  });
}
