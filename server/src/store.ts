import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { SecretBox } from "./crypto.js";
import type { Ctx } from "./integrations/types.js";
import { maskUrlSecret, unmaskUrlSecret } from "./crypto.js";

export interface IntegrationRow { id: string; type: string; name: string; url: string; interval_s: number; enabled: number; secret: string; insecure_tls: number }

export class Store {
  constructor(private db: DB, private box: SecretBox) {}

  listIntegrations(): IntegrationRow[] {
    return this.db.prepare("SELECT id, type, name, url, interval_s, enabled, secret, insecure_tls FROM integrations ORDER BY created_at").all() as unknown as IntegrationRow[];
  }

  getIntegration(id: string): IntegrationRow | undefined {
    return this.db.prepare("SELECT id, type, name, url, interval_s, enabled, secret, insecure_tls FROM integrations WHERE id = ?").get(id) as IntegrationRow | undefined;
  }

  apiKeyOf(row: IntegrationRow): string { return this.box.open(row.secret); }

  ctxOf(row: IntegrationRow): Ctx { return { url: row.url, apiKey: this.box.open(row.secret), insecureTls: Boolean(row.insecure_tls) }; }

  createIntegration(input: { type: string; name: string; url: string; apiKey: string; intervalSeconds: number; insecureTls?: boolean }): string {
    const id = randomUUID().slice(0, 12);
    this.db.prepare("INSERT INTO integrations (id, type, name, url, secret, interval_s, enabled, created_at, insecure_tls) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(id, input.type, input.name, input.url, this.box.seal(input.apiKey), input.intervalSeconds, Date.now(), input.insecureTls ? 1 : 0);
    return id;
  }

  updateIntegration(id: string, input: { name: string; url: string; apiKey?: string; intervalSeconds: number; enabled: boolean; insecureTls?: boolean }): void {
    if (input.apiKey) {
      this.db.prepare("UPDATE integrations SET name=?, url=?, secret=?, interval_s=?, enabled=?, insecure_tls=? WHERE id=?")
        .run(input.name, input.url, this.box.seal(input.apiKey), input.intervalSeconds, input.enabled ? 1 : 0, input.insecureTls ? 1 : 0, id);
    } else {
      this.db.prepare("UPDATE integrations SET name=?, url=?, interval_s=?, enabled=?, insecure_tls=? WHERE id=?")
        .run(input.name, input.url, input.intervalSeconds, input.enabled ? 1 : 0, input.insecureTls ? 1 : 0, id);
    }
  }

  deleteIntegration(id: string): void {
    this.db.prepare("DELETE FROM integrations WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM metrics WHERE instance_id = ?").run(id);
  }

  /** Used by backup restore: keeps the original id so tiles that point at it keep working. */
  importIntegration(i: { id: string; type: string; name: string; url: string; apiKey: string; intervalSeconds: number; enabled: boolean; insecureTls: boolean }): void {
    this.db.prepare("INSERT INTO integrations (id, type, name, url, secret, interval_s, enabled, created_at, insecure_tls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(i.id, i.type, i.name, i.url, this.box.seal(i.apiKey), i.intervalSeconds, i.enabled ? 1 : 0, Date.now(), i.insecureTls ? 1 : 0);
  }

  importCamera(c: { id: string; name: string; main: string; sub: string }): void {
    this.db.prepare("INSERT INTO cameras (id, name, main_url, sub_url, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(c.id, c.name, this.box.seal(c.main), this.box.seal(c.sub), Date.now());
  }

  // ---- cameras: RTSP URLs usually contain a password, so they are sealed and never sent to viewers.

  listCameras(): Array<{ id: string; name: string }> {
    return this.db.prepare("SELECT id, name FROM cameras ORDER BY created_at").all() as unknown as Array<{ id: string; name: string }>;
  }

  getCamera(id: string): { id: string; name: string; main: string; sub: string; createdAt: number } | undefined {
    const row = this.db.prepare("SELECT id, name, main_url, sub_url, created_at FROM cameras WHERE id = ?").get(id) as any;
    return row ? { id: row.id, name: row.name, main: this.box.open(row.main_url), sub: this.box.open(row.sub_url), createdAt: row.created_at } : undefined;
  }

  /** Camera for an admin edit form: passwords are masked. */
  getCameraMasked(id: string) {
    const cam = this.getCamera(id);
    return cam ? { id: cam.id, name: cam.name, main: maskUrlSecret(cam.main), sub: maskUrlSecret(cam.sub) } : undefined;
  }

  createCamera(input: { name: string; main: string; sub: string }): string {
    const id = "c" + randomUUID().replace(/-/g, "").slice(0, 10);
    this.db.prepare("INSERT INTO cameras (id, name, main_url, sub_url, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.name, this.box.seal(input.main), this.box.seal(input.sub), Date.now());
    return id;
  }

  updateCamera(id: string, input: { name: string; main: string; sub: string }): void {
    const old = this.getCamera(id);
    if (!old) return;
    const main = unmaskUrlSecret(input.main, old.main);
    const sub = unmaskUrlSecret(input.sub, old.sub);
    this.db.prepare("UPDATE cameras SET name=?, main_url=?, sub_url=? WHERE id=?").run(input.name, this.box.seal(main), this.box.seal(sub), id);
  }

  deleteCamera(id: string): void { this.db.prepare("DELETE FROM cameras WHERE id = ?").run(id); }
}
