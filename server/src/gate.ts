import type { FastifyInstance } from "fastify";
import type { Deps } from "./deps.js";

const OPEN = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/share/open"]);
/** Changes a read-only viewer is still allowed to make: signing out and changing their own password. */
const VIEWER_WRITES = new Set(["/api/auth/logout", "/api/auth/logout-all", "/api/auth/password"]);

/** One rule for the whole app: nobody sees anything without signing in or holding a valid link. */
export function installMainGate(app: FastifyInstance, d: Deps): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (!path.startsWith("/api/") && !path.startsWith("/go2rtc/")) return;
    if (OPEN.has(path)) return;
    const p = d.access.principal(request);
    if (!p) return reply.code(401).send({ error: "Sign in required" });
    if (p.kind === "share") {
      // A camera link may only ask what it shares and watch those cameras. A wall-display link is read-only.
      const camsOnly = p.share.kind === "cameras";
      const ok = path.startsWith("/api/share/") || (path.startsWith("/go2rtc/")) || (!camsOnly && request.method === "GET");
      if (!ok) return reply.code(403).send({ error: "Not allowed" });
      return;
    }
    if (request.method !== "GET" && p.user.role !== "admin" && !VIEWER_WRITES.has(path)) return reply.code(403).send({ error: "Viewers can look but not change things" });
  });
}
