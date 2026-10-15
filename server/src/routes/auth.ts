import type { FastifyInstance } from "fastify";
import { COOKIE, checkAdminPassword, claimAdmin, createSession, destroySession, isSetUp, loginAllowed, sessionValid, setSessionCookie } from "../auth.js";
import type { DB } from "../db.js";

export function authRoutes(app: FastifyInstance, db: DB): void {
  app.get("/api/auth/status", async request => ({ setup: isSetUp(db), authed: sessionValid(db, request.cookies[COOKIE]) }));

  app.post("/api/auth/setup", async (request, reply) => {
    const { password } = (request.body ?? {}) as { password?: unknown };
    if (typeof password !== "string" || password.length < 8 || password.length > 200) return reply.code(400).send({ error: "Choose a password of at least 8 characters" });
    if (!(await claimAdmin(db, password))) return reply.code(409).send({ error: "An admin password is already set" });
    setSessionCookie(reply, request, createSession(db));
    return { ok: true };
  });

  app.post("/api/auth/login", async (request, reply) => {
    if (!loginAllowed(request.ip)) return reply.code(429).send({ error: "Too many attempts. Wait a minute and try again." });
    const { password } = (request.body ?? {}) as { password?: unknown };
    if (typeof password !== "string" || !(await checkAdminPassword(db, password))) return reply.code(401).send({ error: "Wrong password" });
    setSessionCookie(reply, request, createSession(db));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    destroySession(db, request.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });
}
