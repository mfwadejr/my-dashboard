import type { FastifyInstance } from "fastify";
import { throttleHit } from "../auth.js";
import { ValidationError } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";
import { runCheck } from "../monitors.js";

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
    return { hours, points: monitors.history(id, hours), days: monitors.days(id, 90), recent: monitors.recent(id, 30), events: monitors.events(id, 30), uptimes: monitors.uptimes(id) };
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
      return await runCheck(monitors.forTest(request.body));
    } catch (error) { return bad(reply, error); }
  });

  /** Pause, resume or remove several at once (a whole group, say). */
  app.post("/api/monitors/bulk", admin, async (request, reply) => {
    const b = (request.body ?? {}) as { ids?: unknown; action?: unknown };
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(String))].slice(0, 200) : [];
    if (!ids.length || !["pause", "resume", "remove"].includes(String(b.action))) return reply.code(400).send({ error: "Choose monitors and an action" });
    let n = 0;
    for (const id of ids) {
      if (b.action === "remove") { if (monitors.remove(id)) n++; }
      else if (monitors.update(id, { enabled: b.action === "resume" })) n++;
    }
    logEvent(db, "info", "monitors", `${access.actor(request)} ${b.action === "remove" ? "removed" : b.action === "pause" ? "paused" : "resumed"} ${n} monitor(s)`);
    return { ok: true, changed: n };
  });

  // ---- maintenance windows

  app.get("/api/maintenance-windows", async () => ({ items: monitors.windows.list() }));
  app.post("/api/maintenance-windows", admin, async (request, reply) => {
    try {
      const w = monitors.windows.create(request.body);
      logEvent(db, "info", "monitors", `${access.actor(request)} added the maintenance window "${w.title}"`);
      return w;
    } catch (error) { return bad(reply, error); }
  });
  app.put("/api/maintenance-windows/:id", admin, async (request, reply) => {
    try {
      const w = monitors.windows.update((request.params as { id: string }).id, request.body);
      return w ?? reply.code(404).send({ error: "Not found" });
    } catch (error) { return bad(reply, error); }
  });
  app.delete("/api/maintenance-windows/:id", admin, async (request, reply) => {
    return monitors.windows.remove((request.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: "Not found" });
  });

  // ---- public status pages (managed here, shown by statusOpenRoutes)

  const linkOf = (p: { id: string; token: string; title: string; message: string; tone: string; monitors: string[]; enabled: boolean; views: number; lastUsed: number | null; createdAt: number }) => ({ ...p, path: `/status/${p.token}` });
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
  /** A script, cron job or another service reports in: GET /api/push/<code>?status=up|down&msg=text&ping=ms */
  app.get("/api/push/:token", async (request, reply) => {
    if (!throttleHit(d.db, `push:${request.ip}`, 300, 60_000)) return reply.code(429).send({ ok: false, msg: "Too many requests" });
    const q = request.query as { status?: string; msg?: string; ping?: string };
    const ms = Number(q.ping);
    const ok = d.monitors.heartbeat((request.params as { token: string }).token, String(q.status ?? "up").toLowerCase() !== "down", String(q.msg ?? ""), Number.isFinite(ms) && q.ping ? Math.round(ms) : null);
    if (!ok) {
      if (!throttleHit(d.db, `pushbad:${request.ip}`, 30, 600_000)) return reply.code(429).send({ ok: false, msg: "Too many wrong addresses" });
      return reply.code(404).send({ ok: false, msg: "Unknown push address" });
    }
    return { ok: true };
  });

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
