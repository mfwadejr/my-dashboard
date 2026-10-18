import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import qrcode from "qrcode-generator";
import { COOKIE, authenticate, checkPassword, checkUserPassword, checkUsername, claimFirstAdmin, createSession, destroySession, destroyUserSessions, getUser, isSetUp, touchSession, setSessionCookie, setUserPassword, throttleClear, throttleHit } from "../auth.js";
import { ValidationError } from "../dashboard.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";
import { hashRecovery, looksLikeRecovery, newRecoveryCodes, newSecret, otpauthUrl, verifyTotp } from "../totp.js";
import { getSettings } from "../settings.js";

export function authRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access } = d;

  app.get("/api/auth/status", async request => {
    const p = access.viewer(request);
    const user = !p ? null : p.kind === "user" ? { id: p.user.id, username: p.user.username, role: p.user.role, totp: p.user.totpEnabled, icon: p.user.icon }
      : p.kind === "share" ? { id: "kiosk", username: p.share.name, role: "viewer" as const, totp: false } : { id: p.token.id, username: p.token.name, role: "viewer" as const, totp: false };
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
    if (user.totpEnabled) {
      // The password was right; the second step has to follow within five minutes.
      const ticket = randomBytes(24).toString("base64url");
      tickets.set(ticket, { userId: user.id, exp: Date.now() + 300_000, tries: 0 });
      for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
      return { needs2fa: true, ticket };
    }
    setSessionCookie(reply, request, createSession(db, user.id, request.ip, String(request.headers["user-agent"] ?? "")));
    logEvent(db, "info", "security", `${user.role === "admin" ? "Admin" : "Viewer"} "${user.username}" signed in from ${request.ip}`);
    return { ok: true };
  });

  const tickets = new Map<string, { userId: string; exp: number; tries: number }>();

  /** Accepts a six-digit code from the authenticator app, or one recovery code. Returns what was used, or null. */
  const checkSecondFactor = (userId: string, input: string): "code" | "recovery" | null => {
    const row = db.prepare("SELECT totp_secret, totp_last, recovery FROM users WHERE id = ?").get(userId) as { totp_secret: string; totp_last: number; recovery: string } | undefined;
    if (!row || !row.totp_secret) return null;
    if (looksLikeRecovery(input) && !/^\d{6}$/.test(input.replace(/\s/g, ""))) {
      const hashes: string[] = JSON.parse(row.recovery || "[]"), h = hashRecovery(input), i = hashes.indexOf(h);
      if (i < 0) return null;
      hashes.splice(i, 1);
      db.prepare("UPDATE users SET recovery = ? WHERE id = ?").run(JSON.stringify(hashes), userId);
      return "recovery";
    }
    let secret = "";
    try { secret = d.box.open(row.totp_secret); } catch { return null; }
    const step = verifyTotp(secret, input, row.totp_last);
    if (step === null) return null;
    db.prepare("UPDATE users SET totp_last = ? WHERE id = ?").run(step, userId);
    return "code";
  };

  app.post("/api/auth/login/2fa", async (request, reply) => {
    const body = (request.body ?? {}) as { ticket?: unknown; code?: unknown };
    const t = typeof body.ticket === "string" ? tickets.get(body.ticket) : undefined;
    if (!t || t.exp < Date.now()) return reply.code(401).send({ error: "That sign-in took too long. Enter your password again.", restart: true });
    const user = getUser(db, t.userId);
    if (!user || user.disabled || !throttleHit(db, `2fa:${user.id}`, 8, 300_000)) { tickets.delete(String(body.ticket)); return reply.code(429).send({ error: "Too many attempts. Wait a few minutes and sign in again.", restart: true }); }
    const how = typeof body.code === "string" ? checkSecondFactor(user.id, body.code) : null;
    if (!how) {
      t.tries++;
      logEvent(db, "warn", "security", `Wrong two-factor code for "${user.username}" from ${request.ip}`);
      if (t.tries >= 5) { tickets.delete(String(body.ticket)); return reply.code(401).send({ error: "That code was wrong too many times. Enter your password again.", restart: true }); }
      return reply.code(401).send({ error: "That code is not right. Check the time on your phone and try the newest code." });
    }
    tickets.delete(String(body.ticket)); throttleClear(db, `2fa:${user.id}`);
    setSessionCookie(reply, request, createSession(db, user.id, request.ip, String(request.headers["user-agent"] ?? "")));
    const left = (JSON.parse((db.prepare("SELECT recovery FROM users WHERE id = ?").get(user.id) as { recovery: string }).recovery || "[]") as string[]).length;
    logEvent(db, how === "recovery" ? "warn" : "info", "security", `${user.role === "admin" ? "Admin" : "Viewer"} "${user.username}" signed in from ${request.ip}${how === "recovery" ? ` using a recovery code (${left} left)` : " with two-factor"}`);
    return { ok: true, usedRecovery: how === "recovery", recoveryLeft: left };
  });

  // ---- managing your own two-factor sign-in

  const me = (request: any) => { const p = access.principal(request); return p?.kind === "user" ? p : null; };
  const needPassword = async (userId: string, password: unknown, reply: any): Promise<boolean> => {
    if (!throttleHit(db, `2faadmin:${userId}`, 8, 300_000)) { await reply.code(429).send({ error: "Too many attempts. Wait a few minutes." }); return false; }
    if (typeof password !== "string" || !(await checkUserPassword(db, userId, password))) { await reply.code(401).send({ error: "That password is not right" }); return false; }
    return true;
  };

  app.get("/api/auth/2fa", async (request, reply) => {
    const p = me(request); if (!p) return reply.code(401).send({ error: "Sign in required" });
    const row = db.prepare("SELECT totp_enabled, recovery FROM users WHERE id = ?").get(p.user.id) as { totp_enabled: number; recovery: string };
    return { enabled: Boolean(row.totp_enabled), recoveryLeft: row.totp_enabled ? (JSON.parse(row.recovery || "[]") as string[]).length : 0 };
  });

  /** Step 1: a new secret (not active yet) plus a QR code to scan. */
  app.post("/api/auth/2fa/setup", async (request, reply) => {
    const p = me(request); if (!p) return reply.code(401).send({ error: "Sign in required" });
    if (p.user.totpEnabled) return reply.code(400).send({ error: "Two-factor sign-in is already on. Turn it off first to set it up again." });
    if (!(await needPassword(p.user.id, (request.body as any)?.password, reply))) return;
    const secret = newSecret();
    db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last = 0, recovery = '[]' WHERE id = ?").run(d.box.seal(secret), p.user.id);
    const url = otpauthUrl(p.user.username, secret, getSettings(db).name || "Homebase");
    const qr = qrcode(0, "M"); qr.addData(url); qr.make();
    return { secret: secret.replace(/(.{4})/g, "$1 ").trim(), otpauthUrl: url, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
  });

  /** Step 2: the first code from the app proves it is set up; recovery codes are shown once. */
  app.post("/api/auth/2fa/enable", async (request, reply) => {
    const p = me(request); if (!p) return reply.code(401).send({ error: "Sign in required" });
    const row = db.prepare("SELECT totp_secret, totp_enabled FROM users WHERE id = ?").get(p.user.id) as { totp_secret: string; totp_enabled: number };
    if (row.totp_enabled) return reply.code(400).send({ error: "Two-factor sign-in is already on" });
    if (!row.totp_secret) return reply.code(400).send({ error: "Start the setup first" });
    if (!throttleHit(db, `2faenable:${p.user.id}`, 10, 300_000)) return reply.code(429).send({ error: "Too many attempts. Wait a few minutes." });
    const step = verifyTotp(d.box.open(row.totp_secret), String((request.body as any)?.code ?? ""), 0);
    if (step === null) return reply.code(400).send({ error: "That code is not right. Check the newest code in your app." });
    const codes = newRecoveryCodes();
    db.prepare("UPDATE users SET totp_enabled = 1, totp_last = ?, recovery = ? WHERE id = ?").run(step, JSON.stringify(codes.map(hashRecovery)), p.user.id);
    destroyUserSessions(db, p.user.id, p.hash);
    logEvent(db, "info", "security", `${access.actor(request)} turned on two-factor sign-in (other devices were signed out)`);
    return { ok: true, recoveryCodes: codes };
  });

  app.post("/api/auth/2fa/disable", async (request, reply) => {
    const p = me(request); if (!p) return reply.code(401).send({ error: "Sign in required" });
    const b = (request.body ?? {}) as { password?: unknown; code?: unknown };
    if (!(await needPassword(p.user.id, b.password, reply))) return;
    if (typeof b.code !== "string" || !checkSecondFactor(p.user.id, b.code)) return reply.code(401).send({ error: "That code is not right" });
    db.prepare("UPDATE users SET totp_secret = '', totp_enabled = 0, totp_last = 0, recovery = '[]' WHERE id = ?").run(p.user.id);
    logEvent(db, "warn", "security", `${access.actor(request)} turned off two-factor sign-in`);
    return { ok: true };
  });

  app.post("/api/auth/2fa/recovery", async (request, reply) => {
    const p = me(request); if (!p) return reply.code(401).send({ error: "Sign in required" });
    const b = (request.body ?? {}) as { password?: unknown; code?: unknown };
    if (!p.user.totpEnabled) return reply.code(400).send({ error: "Two-factor sign-in is not on" });
    if (!(await needPassword(p.user.id, b.password, reply))) return;
    if (typeof b.code !== "string" || !checkSecondFactor(p.user.id, b.code)) return reply.code(401).send({ error: "That code is not right" });
    const codes = newRecoveryCodes();
    db.prepare("UPDATE users SET recovery = ? WHERE id = ?").run(JSON.stringify(codes.map(hashRecovery)), p.user.id);
    logEvent(db, "info", "security", `${access.actor(request)} made new recovery codes (the old ones no longer work)`);
    return { ok: true, recoveryCodes: codes };
  });

  /** The page reports real clicks and key presses here so the idle sign-out only counts people who walked away. */
  app.post("/api/auth/activity", async (request, reply) => {
    const p = me(request); if (!p) return reply.code(401).send({ error: "Sign in required" });
    touchSession(db, p.hash);
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
