import type { FastifyInstance } from "fastify";
import { COOKIE, authenticate, checkPassword, checkUserPassword, checkUsername, claimFirstAdmin, createSession, destroySession, destroyUserSessions, isSetUp, setSessionCookie, setUserPassword, throttleClear, throttleHit } from "../auth.js";
import { ValidationError } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";

export function authRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access } = d;

  app.get("/api/auth/status", async request => {
    const p = access.viewer(request);
    const user = p ? (p.kind === "user" ? { id: p.user.id, username: p.user.username, role: p.user.role } : { id: "kiosk", username: p.share.name, role: "viewer" as const }) : null;
    return { setup: isSetUp(db), authed: Boolean(p), user, kiosk: p?.kind === "share" };
  });

  app.post("/api/auth/setup", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
      const username = checkUsername(body.username ?? "admin"), password = checkPassword(body.password);
      const user = await claimFirstAdmin(db, username, password);
      if (!user) return reply.code(409).send({ error: "An admin account already exists" });
      setSessionCookie(reply, request, createSession(db, user.id, request.ip, String(request.headers["user-agent"] ?? "")));
      logEvent(db, "info", "security", `First admin account "${user.username}" was created`);
      return { ok: true };
    } catch (error) {
      if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" && body.username.trim() ? body.username.trim().slice(0, 64) : "admin";
    if (!throttleHit(db, `login:${request.ip}`, 8, 60_000) || !throttleHit(db, `loginu:${username.toLowerCase()}`, 12, 300_000)) {
      logEvent(db, "warn", "security", `Sign-in blocked for "${username}" from ${request.ip}: too many attempts`);
      return reply.code(429).send({ error: "Too many attempts. Wait a minute and try again." });
    }
    const user = typeof body.password === "string" ? await authenticate(db, username, body.password) : null;
    if (!user) {
      logEvent(db, "warn", "security", `Failed sign-in for "${username}" from ${request.ip}`);
      return reply.code(401).send({ error: "Wrong username or password" });
    }
    throttleClear(db, `loginu:${username.toLowerCase()}`);
    setSessionCookie(reply, request, createSession(db, user.id, request.ip, String(request.headers["user-agent"] ?? "")));
    logEvent(db, "info", "security", `${user.role === "admin" ? "Admin" : "Viewer"} "${user.username}" signed in from ${request.ip}`);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    destroySession(db, request.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // Sign out of every device, including this one.
  app.post("/api/auth/logout-all", async (request, reply) => {
    const p = access.principal(request);
    if (p?.kind === "user") { destroyUserSessions(db, p.user.id); logEvent(db, "info", "security", `${access.actor(request)} signed out of all devices`); }
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/password", async (request, reply) => {
    const p = access.principal(request);
    if (p?.kind !== "user") return reply.code(401).send({ error: "Sign in required" });
    const body = (request.body ?? {}) as { current?: unknown; next?: unknown };
    try {
      const next = checkPassword(body.next);
      if (!throttleHit(db, `pw:${p.user.id}`, 8, 300_000)) return reply.code(429).send({ error: "Too many attempts. Wait a few minutes." });
      if (typeof body.current !== "string" || !(await checkUserPassword(db, p.user.id, body.current))) return reply.code(401).send({ error: "The current password is not right" });
      await setUserPassword(db, p.user.id, next);
      destroyUserSessions(db, p.user.id, p.hash);
      logEvent(db, "info", "security", `${access.actor(request)} changed their password (other devices were signed out)`);
      return { ok: true };
    } catch (error) {
      if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}
