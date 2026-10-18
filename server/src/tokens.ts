import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ValidationError } from "./dashboard.js";
import type { DB } from "./db.js";

export type TokenScope = "read" | "write";
export interface TokenRow { id: string; name: string; prefix: string; scope: TokenScope; createdAt: number; createdBy: string; lastUsed: number | null; lastIp: string; uses: number; revoked: boolean; icon: string; iconRef: string }

interface Raw { id: string; name: string; prefix: string; scope: string; created_at: number; created_by: string; last_used: number | null; last_ip: string; uses: number; revoked: number; icon: string; icon_ref: string }
const toRow = (r: Raw): TokenRow => ({ id: r.id, name: r.name, prefix: r.prefix, scope: r.scope === "write" ? "write" : "read", createdAt: r.created_at, createdBy: r.created_by, lastUsed: r.last_used, lastIp: r.last_ip, uses: r.uses, revoked: Boolean(r.revoked), icon: r.icon, iconRef: r.icon_ref });
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const COLS = "id, name, prefix, scope, created_at, created_by, last_used, last_ip, uses, revoked, icon, icon_ref";

/** API tokens let other tools read (or, with read-write, change) the dashboard without a login. Only a hash is stored. */
export class Tokens {
  constructor(private db: DB) {}

  list(): TokenRow[] { return (this.db.prepare(`SELECT ${COLS} FROM api_tokens ORDER BY created_at DESC`).all() as unknown as Raw[]).map(toRow); }
  get(id: string): TokenRow | undefined { const r = this.db.prepare(`SELECT ${COLS} FROM api_tokens WHERE id = ?`).get(id) as Raw | undefined; return r ? toRow(r) : undefined; }

  /** The full token is returned once, here, and can never be shown again. */
  create(nameIn: unknown, scopeIn: unknown, by: string): { token: string; row: TokenRow } {
    const name = typeof nameIn === "string" ? nameIn.trim() : "";
    if (!name || name.length > 40) throw new ValidationError("Give the token a name of 1 to 40 characters, such as the tool that will use it");
    if (scopeIn !== "read" && scopeIn !== "write") throw new ValidationError("Choose read-only or read-write");
    if ((this.db.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE revoked = 0").get() as { n: number }).n >= 50) throw new ValidationError("That is plenty of tokens. Remove ones you no longer use first");
    const token = `hb_${randomBytes(30).toString("base64url")}`, id = "t" + randomUUID().replace(/-/g, "").slice(0, 10);
    this.db.prepare("INSERT INTO api_tokens (id, name, token_hash, prefix, scope, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, name, hash(token), token.slice(0, 9), scopeIn, Date.now(), by);
    return { token, row: this.get(id)! };
  }

  /** The token a request carries, if it is real and not revoked. */
  lookup(raw: string): TokenRow | undefined {
    if (!/^hb_[A-Za-z0-9_-]{20,80}$/.test(raw)) return undefined;
    const r = this.db.prepare(`SELECT ${COLS} FROM api_tokens WHERE token_hash = ?`).get(hash(raw)) as Raw | undefined;
    return r && !r.revoked ? toRow(r) : undefined;
  }

  /** Remembers use. Written at most once a minute per token so a busy tool does not hammer the database. */
  private lastTouch = new Map<string, number>();
  touch(id: string, ip: string): void {
    const now = Date.now();
    this.db.prepare("UPDATE api_tokens SET uses = uses + 1 WHERE id = ?").run(id);
    if (now - (this.lastTouch.get(id) ?? 0) > 60_000) { this.lastTouch.set(id, now); this.db.prepare("UPDATE api_tokens SET last_used = ?, last_ip = ? WHERE id = ?").run(now, ip.slice(0, 64), id); }
  }

  revoke(id: string): boolean { return Number(this.db.prepare("UPDATE api_tokens SET revoked = 1 WHERE id = ? AND revoked = 0").run(id).changes) === 1; }
  remove(id: string): boolean { return Number(this.db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id).changes) === 1; }
}
