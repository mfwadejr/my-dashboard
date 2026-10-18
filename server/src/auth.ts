import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DB } from "./db.js";
import { ValidationError } from "./dashboard.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const COOKIE = "hb_session";
export const SHARE_COOKIE = "hb_share";
export const SESSION_MS = 30 * 24 * 3600 * 1000;

export type Role = "admin" | "viewer";
export interface User { id: string; username: string; role: Role; disabled: boolean; createdAt: number }

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const hashToken = sha;

// ---- accounts

interface UserRow { id: string; username: string; role: string; pass_hash: string; disabled: number; created_at: number }
const toUser = (r: UserRow): User => ({ id: r.id, username: r.username, role: r.role === "admin" ? "admin" : "viewer", disabled: Boolean(r.disabled), createdAt: r.created_at });

export const isSetUp = (db: DB): boolean => Boolean(db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get());

export function checkUsername(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(name)) throw new ValidationError("A username is 2 to 32 letters, numbers, dots, dashes or underscores");
  return name;
}
export function checkPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 200) throw new ValidationError("Choose a password of at least 8 characters");
  return value;
}

/** Creates the first admin only if none exists yet. Returns the user, or null if someone else got there first. */
export async function claimFirstAdmin(db: DB, username: string, password: string): Promise<User | null> {
  const id = "u" + randomUUID().replace(/-/g, "").slice(0, 10);
  const hash = await hashPassword(password);
  const result = db.prepare("INSERT INTO users (id, username, role, pass_hash, created_at) SELECT ?, ?, 'admin', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')").run(id, username, hash, Date.now());
  return Number(result.changes) === 1 ? getUser(db, id)! : null;
}

export async function createUser(db: DB, input: { username: string; password: string; role: Role }): Promise<User> {
  const id = "u" + randomUUID().replace(/-/g, "").slice(0, 10);
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(input.username)) throw new ValidationError("That username is already taken");
  db.prepare("INSERT INTO users (id, username, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, input.username, input.role, await hashPassword(input.password), Date.now());
  return getUser(db, id)!;
}

export const getUser = (db: DB, id: string): User | undefined => {
  const row = db.prepare("SELECT id, username, role, pass_hash, disabled, created_at FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toUser(row) : undefined;
};

export const listUsers = (db: DB): User[] =>
  (db.prepare("SELECT id, username, role, pass_hash, disabled, created_at FROM users ORDER BY created_at").all() as unknown as UserRow[]).map(toUser);

export const adminCount = (db: DB): number => (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;

let dummy: Promise<string> | undefined;
/** Returns the user when the name and password match; takes about the same time either way so names can't be probed. */
export async function authenticate(db: DB, username: string, password: string): Promise<User | null> {
  const row = db.prepare("SELECT id, username, role, pass_hash, disabled, created_at FROM users WHERE username = ?").get(username) as UserRow | undefined;
  if (!row) { await verifyPassword(password, await (dummy ??= hashPassword("not-a-real-password"))); return null; }
  const ok = await verifyPassword(password, row.pass_hash);
  return ok && !row.disabled ? toUser(row) : null;
}

export async function checkUserPassword(db: DB, userId: string, password: string): Promise<boolean> {
  const row = db.prepare("SELECT pass_hash FROM users WHERE id = ?").get(userId) as { pass_hash: string } | undefined;
  return row ? verifyPassword(password, row.pass_hash) : false;
}

export async function setUserPassword(db: DB, userId: string, password: string): Promise<void> {
  db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(await hashPassword(password), userId);
}

// ---- sessions (accounts and share links both get one; share sessions have user_id "share:<id>")

export function createSession(db: DB, userId: string, ip: string, ua: string, ttlMs = SESSION_MS): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at, user_id, last_seen, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)").run(sha(token), now, now + ttlMs, userId, now, ip.slice(0, 64), ua.slice(0, 200));
  return token;
}

export type SessionInfo = { kind: "user"; user: User; hash: string } | { kind: "share"; shareId: string; hash: string };

export function lookupSession(db: DB, token: string | undefined): SessionInfo | undefined {
  if (!token) return undefined;
  const hash = sha(token), now = Date.now();
  const row = db.prepare("SELECT user_id, expires_at, last_seen FROM sessions WHERE token_hash = ?").get(hash) as { user_id: string; expires_at: number; last_seen: number } | undefined;
  if (!row || row.expires_at <= now) return undefined;
  if (now - row.last_seen > 60_000) db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(now, hash);
  if (row.user_id.startsWith("share:")) return { kind: "share", shareId: row.user_id.slice(6), hash };
  const user = getUser(db, row.user_id);
  return user && !user.disabled ? { kind: "user", user, hash } : undefined;
}

export const destroySession = (db: DB, token: string | undefined): void => { if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token)); };
export const destroyUserSessions = (db: DB, userId: string, exceptHash?: string): void => { db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, exceptHash ?? ""); };
export const destroyShareSessions = (db: DB, shareId: string): void => { db.prepare("DELETE FROM sessions WHERE user_id = ?").run(`share:${shareId}`); };

export function listSessions(db: DB): Array<{ id: string; hash: string; userId: string; username: string; createdAt: number; lastSeen: number; ip: string; ua: string }> {
  const rows = db.prepare("SELECT s.token_hash, s.user_id, s.created_at, s.last_seen, s.ip, s.ua, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ? ORDER BY s.last_seen DESC").all(Date.now()) as unknown as Array<{ token_hash: string; user_id: string; created_at: number; last_seen: number; ip: string; ua: string; username: string }>;
  return rows.map(r => ({ id: r.token_hash.slice(0, 16), hash: r.token_hash, userId: r.user_id, username: r.username, createdAt: r.created_at, lastSeen: r.last_seen, ip: r.ip, ua: r.ua }));
}
export const destroySessionById = (db: DB, id: string): number =>
  Number(db.prepare("DELETE FROM sessions WHERE substr(token_hash, 1, 16) = ? AND user_id NOT LIKE 'share:%'").run(id).changes);

export function setSessionCookie(reply: FastifyReply, request: FastifyRequest, token: string, name = COOKIE, ttlMs = SESSION_MS): void {
  reply.setCookie(name, token, {
    httpOnly: true, sameSite: name === COOKIE ? "strict" : "lax", path: "/",
    secure: request.protocol === "https", maxAge: Math.floor(ttlMs / 1000)
  });
}

/** Counts attempts in the database so a restart does not reset the limit. Returns false once `limit` is exceeded within the window. */
export function throttleHit(db: DB, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const row = db.prepare(
    "INSERT INTO throttle (k, n, reset_at) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset_at < ? THEN 1 ELSE n + 1 END, reset_at = CASE WHEN reset_at < ? THEN ? ELSE reset_at END RETURNING n"
  ).get(key, now + windowMs, now, now, now + windowMs) as { n: number };
  if (Math.random() < 0.02) db.prepare("DELETE FROM throttle WHERE reset_at < ?").run(now);
  return row.n <= limit;
}
export const throttleClear = (db: DB, key: string): void => { db.prepare("DELETE FROM throttle WHERE k = ?").run(key); };
