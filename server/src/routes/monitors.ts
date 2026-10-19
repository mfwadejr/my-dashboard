import type { FastifyInstance } from "fastify";
import { throttleHit } from "../auth.js";
import { ValidationError } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";
import { cleanMonitor, runCheck } from "../monitors.js";

/** Signed-in people read monitors; only administrators change them. */
export function monitorRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access, monitors, statusPages } = d;
  const admin = { preHandler: access.requireAdmin };
  const isAdmin = (request: Parameters<typeof access.principal>[0]) => { const p = access.principal(request); return p?.kind === "user" && p.user.role === "admin"; };
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
    throw error;
  };

  app.get("/api/monitors", async request => ({ items: monitors.view(isAdmin(request)) }));

  app.get("/api/monitors/:id/history", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!monitors.get(id)) return reply.code(404).send({ error: "Not found" });
    const hours = Number((request.query as { hours?: string }).hours ?? 24) || 24;
    return { hours, points: monitors.history(id, hours), days: monitors.days(id, 45), recent: monitors.recent(id, 30) };
  });

  app.post("/api/monitors", admin, async (request, reply) => {
    try {
      const m = monitors.create(request.body);
      logEvent(db, "info", "monitors", `${access.actor(request)} added the monitor "${m.name}"`);
      return m;
    } catch (error) { return bad(reply, error); }
  });

  app.put("/api/monitors/:id", admin, async (request, reply) => {
    try {
      const m = monitors.update((request.params as { id: string }).id, request.body);
      if (!m) return reply.code(404).send({ error: "Not found" });
      logEvent(db, "info", "monitors", `${access.actor(request)} changed the monitor "${m.name}"`);
      return m;
    } catch (error) { return bad(reply, error); }
  });

  app.delete("/api/monitors/:id", admin, async (request, reply) => {
    const id = (request.params as { id: string }).id, m = monitors.get(id);
    if (!m || !monitors.remove(id)) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "monitors", `${access.actor(request)} removed the monitor "${m.name}"`);
    return { ok: true };
  });

  app.post("/api/monitors/:id/check", admin, async (request, reply) => {
    const r = await monitors.checkNow((request.params as { id: string }).id);
    return r ?? reply.code(404).send({ error: "Not found" });
  });

  /** Try a monitor before saving it. */
  app.post("/api/monitors/test", admin, async (request, reply) => {
    try {
      if (!throttleHit(db, `montest:${access.actor(request)}`, 30, 60_000)) return reply.code(429).send({ error: "Too many tests. Wait a minute." });
      const c = cleanMonitor(request.body);
      return await runCheck(c);
    } catch (error) { return bad(reply, error); }
  });

  // ---- public status pages (managed here, shown by statusOpenRoutes)

  const linkOf = (p: { id: string; token: string; title: string; message: string; monitors: string[]; enabled: boolean; views: number; lastUsed: number | null; createdAt: number }) => ({ ...p, path: `/status/${p.token}` });
  app.get("/api/status-pages", admin, async () => ({ items: statusPages.list().map(linkOf) }));
  app.post("/api/status-pages", admin, async (request, reply) => {
    try {
      const p = statusPages.create(request.body);
      logEvent(db, "info", "sharing", `${access.actor(request)} created the status page "${p.title}"`);
      return linkOf(p);
    } catch (error) { return bad(reply, error); }
  });
  app.put("/api/status-pages/:id", admin, async (request, reply) => {
    try {
      const p = statusPages.update((request.params as { id: string }).id, request.body);
      if (!p) return reply.code(404).send({ error: "Not found" });
      return linkOf(p);
    } catch (error) { return bad(reply, error); }
  });
  app.post("/api/status-pages/:id/new-link", admin, async (request, reply) => {
    const p = statusPages.rotate((request.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "sharing", `${access.actor(request)} made a new link for the status page "${p.title}"; the old link stopped working`);
    return linkOf(p);
  });
  app.delete("/api/status-pages/:id", admin, async (request, reply) => {
    const id = (request.params as { id: string }).id, p = statusPages.list().find(x => x.id === id);
    if (!p || !statusPages.remove(id)) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "sharing", `${access.actor(request)} removed the status page "${p.title}"`);
    return { ok: true };
  });
}

/** What anyone holding a status page link can read. Registered on both ports. */
export function statusOpenRoutes(app: FastifyInstance, d: Deps): void {
  app.get("/api/status/:token", async (request, reply) => {
    if (!throttleHit(d.db, `statuspage:${request.ip}`, 120, 60_000)) return reply.code(429).send({ error: "Too many requests. Wait a minute." });
    const view = d.statusPages.publicView((request.params as { token: string }).token);
    if (!view) {
      if (!throttleHit(d.db, `statusbad:${request.ip}`, 20, 600_000)) return reply.code(429).send({ error: "Too many wrong links. Wait ten minutes." });
      return reply.code(404).send({ error: "This status page is not available." });
    }
    return view;
  });
}
