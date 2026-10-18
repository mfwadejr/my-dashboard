import type { FastifyInstance } from "fastify";
import { throttleHit, touchSession } from "./auth.js";
import { logEvent, verbosity } from "./db.js";
import type { Deps } from "./deps.js";

const OPEN = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/login/2fa", "/api/auth/setup", "/api/share/open"]);
/** Changes a read-only viewer is still allowed to make: signing out and changing their own password. */
const VIEWER_WRITES = new Set(["/api/auth/logout", "/api/auth/logout-all", "/api/auth/password", "/api/auth/activity"]);
const isOwnSecurity = (path: string) => path.startsWith("/api/auth/2fa/");

/** One rule for the whole app: nobody sees anything without signing in or holding a valid link. */
export function installMainGate(app: FastifyInstance, d: Deps): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (!path.startsWith("/api/") && !path.startsWith("/go2rtc/")) return;
    if (OPEN.has(path)) return;
    const p = d.access.principal(request);
    if (!p) return reply.code(401).send({ error: "Sign in required" });
    if (p.kind === "token") {
      // Tokens are for reading data and a few agreed changes. Camera video and everything about people, backups and sharing stays closed to them.
      if (path.startsWith("/go2rtc/")) return reply.code(403).send({ error: "API tokens cannot open camera streams" });
      if (!throttleHit(d.db, `tok:${p.token.id}`, 600, 60_000)) return reply.code(429).send({ error: "Too many requests from this token. Slow down." });
      if (request.method !== "GET" && p.token.scope !== "write") return reply.code(403).send({ error: "This API token is read-only" });
      d.tokens.touch(p.token.id, request.ip);
      logTokenUse(d, p.token.id, p.token.name, request.method, path, request.ip);
      return;
    }
    if (p.kind === "share") {
      // A camera link may only ask what it shares and watch those cameras. A wall-display link is read-only.
      const camsOnly = p.share.kind === "cameras";
      const ok = path.startsWith("/api/share/") || (path.startsWith("/go2rtc/")) || (!camsOnly && request.method === "GET");
      if (!ok) return reply.code(403).send({ error: "Not allowed" });
      return;
    }
    if (request.method !== "GET") touchSession(d.db, p.hash);
    if (request.method !== "GET" && p.user.role !== "admin" && !VIEWER_WRITES.has(path) && !isOwnSecurity(path)) return reply.code(403).send({ error: "Viewers can look but not change things" });
  });
}

const seen = new Map<string, { at: number; skipped: number }>();
/** Writes "API token X read /api/…" to the log. Repeats of the same call inside a minute are counted rather than listed, so a tool polling every few seconds does not flood the log (detailed mode lists every call). */
function logTokenUse(d: Deps, id: string, name: string, method: string, path: string, ip: string): void {
  const route = path.split("/").slice(0, 4).join("/");
  const key = `${id}|${method}|${route}`, now = Date.now(), prev = seen.get(key);
  const what = method === "GET" ? "read" : "changed";
  if (verbosity(d.db) === "detailed") { logEvent(d.db, "info", "api", `API token "${name}" ${what} ${path} from ${ip}`); return; }
  if (prev && now - prev.at < 60_000) { prev.skipped++; return; }
  const more = prev?.skipped ? ` (plus ${prev.skipped} similar call(s) since the last entry)` : "";
  seen.set(key, { at: now, skipped: 0 });
  if (seen.size > 500) for (const [k, v] of seen) if (now - v.at > 60_000) seen.delete(k);
  logEvent(d.db, "info", "api", `API token "${name}" ${what} ${route} from ${ip}${more}`);
}
