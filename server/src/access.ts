import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { COOKIE, SHARE_COOKIE, lookupSession, type User } from "./auth.js";
import type { DB } from "./db.js";
import type { ShareRow, Shares } from "./shares.js";
import type { TokenRow, Tokens } from "./tokens.js";

export type Principal = { kind: "user"; user: User; hash: string } | { kind: "share"; share: ShareRow; hash: string } | { kind: "token"; token: TokenRow; hash: string };

/** Works out who a request is from. Accounts use the session cookie; share links use their own cookie. */
export class Access {
  private cache = new WeakMap<FastifyRequest, Principal | null>();
  constructor(private db: DB, private shares: Shares, private tokens: Tokens) {}

  principal = (request: FastifyRequest, opts: { shareOnly?: boolean } = {}): Principal | null => {
    const cached = this.cache.get(request);
    if (cached !== undefined) return cached;
    let found: Principal | null = null;
    // A request that carries an API token is judged by the token alone; cookies are ignored for it.
    const auth = request.headers.authorization;
    if (typeof auth === "string" && /^Bearer\s/i.test(auth)) {
      if (!opts.shareOnly) {
        const t = this.tokens.lookup(auth.replace(/^Bearer\s+/i, "").trim());
        if (t) found = { kind: "token", token: t, hash: t.id };
      }
      this.cache.set(request, found);
      return found;
    }
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

  /** Everyone who may look at the dashboard: signed-in accounts, API tokens and kiosk links (not camera-only links). */
  viewer = (request: FastifyRequest): Principal | null => {
    const p = this.principal(request);
    return p && (p.kind !== "share" || p.share.kind === "kiosk") ? p : null;
  };

  requireAdmin: preHandlerAsyncHookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const p = this.principal(request);
    if (!p) { await reply.code(401).send({ error: "Sign in required" }); return; }
    if (p.kind === "token") { await reply.code(403).send({ error: "API tokens cannot do that. It needs a signed-in admin." }); return; }
    if (p.kind !== "user" || p.user.role !== "admin") await reply.code(403).send({ error: "Only an admin can do that" });
  };

  /** Admins, plus read-write API tokens, for the few changes that other tools are allowed to make (layout, connection actions). */
  requireWriter: preHandlerAsyncHookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const p = this.principal(request);
    if (!p) { await reply.code(401).send({ error: "Sign in required" }); return; }
    if (p.kind === "token") { if (p.token.scope !== "write") await reply.code(403).send({ error: "This API token is read-only" }); return; }
    if (p.kind !== "user" || p.user.role !== "admin") await reply.code(403).send({ error: "Only an admin can do that" });
  };

  /** Name shown in the log for whoever made a change. */
  actor = (request: FastifyRequest): string => {
    const p = this.principal(request);
    if (!p) return "Someone";
    if (p.kind === "token") return `API token "${p.token.name}"`;
    return p.kind === "user" ? `${p.user.role === "admin" ? "Admin" : "Viewer"} "${p.user.username}"` : `Link "${p.share.name}"`;
  };
}
