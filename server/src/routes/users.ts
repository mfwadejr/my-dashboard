import type { FastifyInstance } from "fastify";
import { adminCount, checkPassword, checkUsername, createUser, destroySessionById, destroyUserSessions, getUser, listSessions, listUsers, setUserPassword } from "../auth.js";
import { ValidationError } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";

export function userRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access } = d;
  const admin = { preHandler: access.requireAdmin };
  const fail = (reply: any, error: unknown) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
    throw error;
  };

  app.get("/api/users", admin, async () => listUsers(db));

  app.post("/api/users", admin, async (request, reply) => {
    try {
      const b = (request.body ?? {}) as Record<string, unknown>;
      const role = b.role === "admin" ? "admin" : "viewer";
      const user = await createUser(db, { username: checkUsername(b.username), password: checkPassword(b.password), role });
      logEvent(db, "info", "security", `${access.actor(request)} created the ${role} account "${user.username}"`);
      return user;
    } catch (e) { return fail(reply, e); }
  });

  app.put("/api/users/:id", admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = getUser(db, id);
    if (!target) return reply.code(404).send({ error: "Not found" });
    try {
      const b = (request.body ?? {}) as Record<string, unknown>;
      const role = b.role === undefined ? target.role : b.role === "admin" ? "admin" : "viewer";
      const disabled = b.disabled === undefined ? target.disabled : Boolean(b.disabled);
      const me = access.principal(request);
      const losesAdmin = target.role === "admin" && !target.disabled && (role !== "admin" || disabled);
      if (losesAdmin && adminCount(db) <= 1) throw new ValidationError("There must always be at least one active admin");
      if (me?.kind === "user" && me.user.id === id && disabled) throw new ValidationError("You cannot switch off your own account");
      db.prepare("UPDATE users SET role = ?, disabled = ? WHERE id = ?").run(role, disabled ? 1 : 0, id);
      const notes: string[] = [];
      if (role !== target.role) notes.push(`role is now ${role}`);
      if (disabled !== target.disabled) notes.push(disabled ? "account switched off" : "account switched on");
      if (b.resetTwoFactor === true) {
        db.prepare("UPDATE users SET totp_secret = '', totp_enabled = 0, totp_last = 0, recovery = '[]' WHERE id = ?").run(id);
        destroyUserSessions(db, id, me?.kind === "user" && me.user.id === id ? me.hash : undefined);
        notes.push("two-factor sign-in was reset");
      }
      if (b.password !== undefined && b.password !== "") { await setUserPassword(db, id, checkPassword(b.password)); notes.push("password was reset"); destroyUserSessions(db, id); }
      else if (disabled || role !== target.role) destroyUserSessions(db, id, me?.kind === "user" && me.user.id === id ? me.hash : undefined);
      if (notes.length) logEvent(db, "info", "security", `${access.actor(request)} changed "${target.username}": ${notes.join(", ")}`);
      return getUser(db, id);
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/api/users/:id", admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = getUser(db, id);
    if (!target) return reply.code(404).send({ error: "Not found" });
    const me = access.principal(request);
    if (me?.kind === "user" && me.user.id === id) return reply.code(400).send({ error: "You cannot delete your own account" });
    if (target.role === "admin" && !target.disabled && adminCount(db) <= 1) return reply.code(400).send({ error: "There must always be at least one active admin" });
    destroyUserSessions(db, id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    logEvent(db, "info", "security", `${access.actor(request)} deleted the account "${target.username}"`);
    return { ok: true };
  });

  app.get("/api/sessions", admin, async request => {
    const me = access.principal(request);
    return listSessions(db).map(({ hash, ...s }) => ({ ...s, current: me?.hash === hash }));
  });

  app.delete("/api/sessions/:id", admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!destroySessionById(db, id)) return reply.code(404).send({ error: "That session has already ended" });
    logEvent(db, "info", "security", `${access.actor(request)} ended a signed-in session`);
    return { ok: true };
  });
}
