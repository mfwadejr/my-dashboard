import type { FastifyInstance } from "fastify";
import { SHARE_COOKIE, createSession, destroyShareSessions, setSessionCookie, throttleHit } from "../auth.js";
import { ValidationError } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";
import type { ShareRow } from "../shares.js";

const info = (d: Deps, s: ShareRow) => ({
  kind: s.kind, name: s.name, expiresAt: s.expiresAt,
  cameras: s.cameras.map(id => ({ id, name: d.store.getCameraMasked(id)?.name ?? "" })).filter(c => c.name)
});

/** What a person holding a link can do: open it (with a PIN if there is one) and ask what it shares. Used by both ports. */
export function shareOpenRoutes(app: FastifyInstance, d: Deps, publicOnly: boolean): void {
  const { db, shares, access } = d;
  const NOT_VALID = "This link is not valid any more. Ask the person who sent it for a new one.";

  app.post("/api/share/open", async (request, reply) => {
    if (!throttleHit(db, `shareopen:${request.ip}`, 60, 60_000)) return reply.code(429).send({ error: "Too many requests. Wait a minute." });
    const body = (request.body ?? {}) as { token?: unknown; pin?: unknown };
    const found = typeof body.token === "string" ? shares.byToken(body.token) : undefined;
    if (!found || !shares.usable(found.share) || (publicOnly && found.share.kind === "kiosk")) {
      if (!throttleHit(db, `sharebad:${request.ip}`, 15, 600_000)) return reply.code(429).send({ error: "Too many wrong links. Wait ten minutes." });
      return reply.code(404).send({ error: NOT_VALID });
    }
    const { share, pinHash } = found;
    const existing = access.principal(request, { shareOnly: publicOnly });
    const already = existing?.kind === "share" && existing.share.id === share.id;
    if (pinHash && !already) {
      const pin = typeof body.pin === "string" ? body.pin : "";
      if (!pin) return reply.code(401).send({ needsPin: true, error: "Enter the PIN for this link" });
      if (!throttleHit(db, `sharepin:${share.id}:${request.ip}`, 8, 600_000)) return reply.code(429).send({ error: "Too many wrong PINs. Wait ten minutes." });
      if (!(await shares.pinOk(pinHash, pin))) {
        logEvent(db, "warn", "share", `Wrong PIN for link "${share.name}" from ${request.ip}`);
        return reply.code(401).send({ needsPin: true, error: "That PIN is not right" });
      }
    }
    if (!already) {
      const ttl = Math.min(12 * 3600_000, share.expiresAt === null ? Infinity : share.expiresAt - Date.now());
      setSessionCookie(reply, request, createSession(db, `share:${share.id}`, request.ip, String(request.headers["user-agent"] ?? ""), ttl), SHARE_COOKIE, ttl);
      if (!share.lastUsed || Date.now() - share.lastUsed > 30 * 60_000) logEvent(db, "info", "share", `Link "${share.name}" was opened from ${request.ip}`);
      shares.touch(share.id);
    }
    return info(d, share);
  });

  app.get("/api/share/me", async (request, reply) => {
    const p = access.principal(request, { shareOnly: publicOnly });
    if (p?.kind !== "share") return reply.code(401).send({ error: "Open your link again" });
    return info(d, p.share);
  });
}

export function shareAdminRoutes(app: FastifyInstance, d: Deps): void {
  const { db, shares, access, store } = d;
  const admin = { preHandler: access.requireAdmin };

  app.get("/api/shares", admin, async () => shares.list());

  app.post("/api/shares", admin, async (request, reply) => {
    try {
      const b = (request.body ?? {}) as Record<string, unknown>;
      const kind = b.kind === "kiosk" ? "kiosk" : "cameras";
      const created = await shares.create({
        name: String(b.name ?? ""), kind, cameras: Array.isArray(b.cameras) ? b.cameras.filter((x): x is string => typeof x === "string") : [],
        pin: typeof b.pin === "string" ? b.pin : "", expiresIn: String(b.expiresIn ?? "7d"), createdBy: access.actor(request)
      }, id => Boolean(store.getCamera(id)));
      logEvent(db, "info", "share", `${access.actor(request)} created the ${kind === "kiosk" ? "wall-display" : "camera"} link "${created.name}"${created.expiresAt ? "" : " (never expires)"}${created.hasPin ? " with a PIN" : ""}`);
      return created;
    } catch (error) {
      if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/shares/:id/revoke", admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    const s = shares.get(id);
    if (!s || !shares.revoke(id)) return reply.code(404).send({ error: "Not found" });
    destroyShareSessions(db, id);
    logEvent(db, "info", "share", `${access.actor(request)} revoked the link "${s.name}"`);
    return { ok: true };
  });

  app.delete("/api/shares/:id", admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    const s = shares.get(id);
    if (!s) return reply.code(404).send({ error: "Not found" });
    destroyShareSessions(db, id);
    shares.remove(id);
    logEvent(db, "info", "share", `${access.actor(request)} deleted the link "${s.name}"`);
    return { ok: true };
  });
}
