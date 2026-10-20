import type { FastifyInstance } from "fastify";
import { ValidationError } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";

/** Signed-in people see the racks (without notes); only administrators change them. */
export function rackRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access, racks } = d;
  const admin = { preHandler: access.requireAdmin };
  const isAdmin = (request: Parameters<typeof access.principal>[0]) => { const p = access.principal(request); return p?.kind === "user" && p.user.role === "admin"; };
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
    throw error;
  };

  app.get("/api/racks", async request => ({ items: racks.list(isAdmin(request)) }));

  app.post("/api/racks", admin, async (request, reply) => {
    try {
      const r = racks.createRack(request.body);
      logEvent(db, "info", "racks", `${access.actor(request)} added the rack "${r.name}" (${r.units}U)`);
      return r;
    } catch (error) { return bad(reply, error); }
  });

  app.put("/api/racks/order", admin, async request => {
    const ids = Array.isArray((request.body as { ids?: unknown })?.ids) ? ((request.body as { ids: unknown[] }).ids).map(String) : [];
    racks.order(ids);
    return { ok: true };
  });

  app.put("/api/racks/:id", admin, async (request, reply) => {
    try {
      const r = racks.updateRack((request.params as { id: string }).id, request.body);
      if (!r) return reply.code(404).send({ error: "Not found" });
      logEvent(db, "info", "racks", `${access.actor(request)} changed the rack "${r.name}"`);
      return r;
    } catch (error) { return bad(reply, error); }
  });

  app.delete("/api/racks/:id", admin, async (request, reply) => {
    const id = (request.params as { id: string }).id, r = racks.get(id);
    if (!r || !racks.removeRack(id)) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "racks", `${access.actor(request)} removed the rack "${r.name}"`);
    return { ok: true };
  });

  app.post("/api/racks/:id/devices", admin, async (request, reply) => {
    try {
      const dev = racks.createDevice((request.params as { id: string }).id, request.body);
      logEvent(db, "info", "racks", `${access.actor(request)} added "${dev.name}" to a rack`, { detail: true });
      return dev;
    } catch (error) { return bad(reply, error); }
  });

  app.put("/api/racks/devices/:id", admin, async (request, reply) => {
    try {
      const dev = racks.updateDevice((request.params as { id: string }).id, request.body);
      if (!dev) return reply.code(404).send({ error: "Not found" });
      logEvent(db, "info", "racks", `${access.actor(request)} changed "${dev.name}" in a rack`, { detail: true });
      return dev;
    } catch (error) { return bad(reply, error); }
  });

  app.delete("/api/racks/devices/:id", admin, async (request, reply) => {
    const id = (request.params as { id: string }).id, dev = racks.getDevice(id);
    if (!dev || !racks.removeDevice(id)) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "racks", `${access.actor(request)} removed "${dev.name}" from a rack`, { detail: true });
    return { ok: true };
  });
}
