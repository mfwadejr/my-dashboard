import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { COOKIE, SHARE_COOKIE, lookupSession, type User } from "./auth.js";
import type { DB } from "./db.js";
import type { ShareRow, Shares } from "./shares.js";

export type Principal = { kind: "user"; user: User; hash: string } | { kind: "share"; share: ShareRow; hash: string };

/** Works out who a request is from. Accounts use the session cookie; share links use their own cookie. */
export class Access {
  private cache = new WeakMap<FastifyRequest, Principal | null>();
  constructor(private db: DB, private shares: Shares) {}

  principal = (request: FastifyRequest, opts: { shareOnly?: boolean } = {}): Principal | null => {
    const cached = this.cache.get(request);
    if (cached !== undefined) return cached;
    let found: Principal | null = null;
    if (!opts.shareOnly) {
      const s = lookupSession(this.db, request.cookies?.[COOKIE]);
      if (s?.kind === "user") found = { kind: "user", user: s.user, hash: s.hash };
    }
    if (!found) {
      const s = lookupSession(this.db, request.cookies?.[SHARE_COOKIE]);
      if (s?.kind === "share") {
        const share = this.shares.get(s.shareId);
        if (share && this.shares.usable(share) && !(opts.shareOnly && share.kind !== "cameras")) found = { kind: "share", share, hash: s.hash };
      }
    }
    this.cache.set(request, found);
    return found;
  };

  /** Everyone who may look at the dashboard: signed-in accounts and kiosk links (not camera-only links). */
  viewer = (request: FastifyRequest): Principal | null => {
    const p = this.principal(request);
    return p && (p.kind === "user" || p.share.kind === "kiosk") ? p : null;
  };

  requireAdmin: preHandlerAsyncHookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const p = this.principal(request);
    if (!p) { await reply.code(401).send({ error: "Sign in required" }); return; }
    if (p.kind !== "user" || p.user.role !== "admin") await reply.code(403).send({ error: "Only an admin can do that" });
  };

  /** Name shown in the log for whoever made a change. */
  actor = (request: FastifyRequest): string => {
    const p = this.principal(request);
    if (!p) return "Someone";
    return p.kind === "user" ? `${p.user.role === "admin" ? "Admin" : "Viewer"} "${p.user.username}"` : `Link "${p.share.name}"`;
  };
}
