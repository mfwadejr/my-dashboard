import { randomBytes, randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { SecretBox } from "./crypto.js";
import { ValidationError } from "./dashboard.js";
import { hashPassword, hashToken, verifyPassword } from "./auth.js";

export type ShareKind = "cameras" | "kiosk";
export interface ShareRow {
  id: string; name: string; kind: ShareKind; cameras: string[]; expiresAt: number | null; revoked: boolean;
  createdAt: number; lastUsed: number | null; views: number; createdBy: string; hasPin: boolean;
}
interface Raw { id: string; name: string; kind: string; cameras: string; token_hash: string; token_sealed: string; pin_hash: string; expires_at: number | null; revoked: number; created_at: number; last_used: number | null; views: number; created_by: string }
const COLS = "id, name, kind, cameras, token_hash, token_sealed, pin_hash, expires_at, revoked, created_at, last_used, views, created_by";

const EXPIRY: Record<string, number | null> = { "1h": 3600e3, "1d": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3, never: null };
export const EXPIRY_CHOICES = Object.keys(EXPIRY);

export class Shares {
  constructor(private db: DB, private box: SecretBox) {}

  private map(r: Raw): ShareRow {
    return { id: r.id, name: r.name, kind: r.kind === "kiosk" ? "kiosk" : "cameras", cameras: JSON.parse(r.cameras), expiresAt: r.expires_at, revoked: Boolean(r.revoked), createdAt: r.created_at, lastUsed: r.last_used, views: r.views, createdBy: r.created_by, hasPin: Boolean(r.pin_hash) };
  }

  /** A link works only while it is not revoked and not past its expiry. */
  usable(s: ShareRow): boolean { return !s.revoked && (s.expiresAt === null || s.expiresAt > Date.now()); }

  list(): Array<ShareRow & { token: string }> {
    return (this.db.prepare(`SELECT ${COLS} FROM shares ORDER BY created_at DESC`).all() as unknown as Raw[]).map(r => ({ ...this.map(r), token: this.box.open(r.token_sealed) }));
  }

  get(id: string): ShareRow | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM shares WHERE id = ?`).get(id) as Raw | undefined;
    return r ? this.map(r) : undefined;
  }

  byToken(token: string): { share: ShareRow; pinHash: string } | undefined {
    if (typeof token !== "string" || token.length < 20 || token.length > 80) return undefined;
    const r = this.db.prepare(`SELECT ${COLS} FROM shares WHERE token_hash = ?`).get(hashToken(token)) as Raw | undefined;
    return r ? { share: this.map(r), pinHash: r.pin_hash } : undefined;
  }

  async create(input: { name: string; kind: ShareKind; cameras: string[]; pin?: string; expiresIn: string; createdBy: string }, cameraExists: (id: string) => boolean): Promise<ShareRow & { token: string }> {
    const name = input.name.trim();
    if (!name || name.length > 60) throw new ValidationError("Give the link a name (up to 60 characters)");
    if (!(input.expiresIn in EXPIRY)) throw new ValidationError("Choose how long the link should last");
    let cameras: string[] = [];
    if (input.kind === "cameras") {
      cameras = [...new Set(input.cameras)];
      if (!cameras.length) throw new ValidationError("Choose at least one camera to share");
      if (cameras.length > 24) throw new ValidationError("A link can share up to 24 cameras");
      const missing = cameras.find(c => !cameraExists(c));
      if (missing) throw new ValidationError("One of the chosen cameras no longer exists");
    }
    const pin = (input.pin ?? "").trim();
    if (pin && (pin.length < 4 || pin.length > 32)) throw new ValidationError("A PIN is 4 to 32 characters");
    const token = randomBytes(24).toString("base64url");
    const id = "s" + randomUUID().replace(/-/g, "").slice(0, 10);
    const ttl = EXPIRY[input.expiresIn];
    this.db.prepare(`INSERT INTO shares (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 0, ?)`)
      .run(id, name, input.kind, JSON.stringify(cameras), hashToken(token), this.box.seal(token), pin ? await hashPassword(pin) : "", ttl === null ? null : Date.now() + ttl, Date.now(), input.createdBy);
    return { ...this.get(id)!, token };
  }

  async pinOk(pinHash: string, pin: unknown): Promise<boolean> {
    return typeof pin === "string" && pin.length > 0 && verifyPassword(pin, pinHash);
  }

  revoke(id: string): boolean { return Number(this.db.prepare("UPDATE shares SET revoked = 1 WHERE id = ?").run(id).changes) === 1; }
  remove(id: string): boolean { return Number(this.db.prepare("DELETE FROM shares WHERE id = ?").run(id).changes) === 1; }
  touch(id: string): void { this.db.prepare("UPDATE shares SET views = views + 1, last_used = ? WHERE id = ?").run(Date.now(), id); }
  /** Camera ids that are removed also leave every link that shared them. */
  forgetCamera(cameraId: string): void {
    for (const s of this.list()) if (s.cameras.includes(cameraId)) this.db.prepare("UPDATE shares SET cameras = ? WHERE id = ?").run(JSON.stringify(s.cameras.filter(c => c !== cameraId)), s.id);
  }
}
