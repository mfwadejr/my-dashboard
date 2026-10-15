import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getMeta, setMeta, type DB } from "./db.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const COOKIE = "hb_session";
const SESSION_MS = 30 * 24 * 3600 * 1000;

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

export const isSetUp = (db: DB): boolean => Boolean(getMeta(db, "admin_hash"));

/** Sets the admin password only if none exists yet. Returns false if someone else got there first. */
export async function claimAdmin(db: DB, password: string): Promise<boolean> {
  const hash = await hashPassword(password);
  const result = db.prepare("INSERT INTO meta (k, v) VALUES ('admin_hash', ?) ON CONFLICT(k) DO NOTHING").run(hash);
  return Number(result.changes) === 1;
}

export async function changeAdminPassword(db: DB, password: string): Promise<void> {
  setMeta(db, "admin_hash", await hashPassword(password));
  db.exec("DELETE FROM sessions");
}

export async function checkAdminPassword(db: DB, password: string): Promise<boolean> {
  const stored = getMeta(db, "admin_hash");
  return stored ? verifyPassword(password, stored) : false;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function createSession(db: DB): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(sha(token), now, now + SESSION_MS);
  return token;
}

export function sessionValid(db: DB, token: string | undefined): boolean {
  if (!token) return false;
  const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(sha(token)) as { expires_at: number } | undefined;
  return Boolean(row && row.expires_at > Date.now());
}

export function destroySession(db: DB, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
}

export function setSessionCookie(reply: FastifyReply, request: FastifyRequest, token: string): void {
  reply.setCookie(COOKIE, token, {
    httpOnly: true, sameSite: "strict", path: "/", secure: request.protocol === "https", maxAge: SESSION_MS / 1000
  });
}

/** Simple in-memory login throttle: 8 attempts per minute per client address. */
const attempts = new Map<string, { n: number; reset: number }>();
export function loginAllowed(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.reset < now) { attempts.set(ip, { n: 1, reset: now + 60_000 }); return true; }
  entry.n += 1;
  return entry.n <= 8;
}

export function makeRequireAuth(db: DB) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!sessionValid(db, request.cookies[COOKIE])) {
      await reply.code(401).send({ error: "Sign in required" });
    }
  };
}
