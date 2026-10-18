import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MASK, maskUrlSecret } from "./crypto.js";
import { ValidationError, readDashboard, validateDashboard, writeDashboard, type TabDoc } from "./dashboard.js";
import { logEvent, tx } from "./db.js";
import { INTEGRATION_TYPES } from "./integrations/registry.js";
import { normalizeUrl } from "./integrations/http.js";
import { DEFAULTS, getSettings, updateSettings } from "./settings.js";
import { versionInfo } from "./version.js";
import type { Deps } from "./deps.js";

export const BACKUP_FORMAT = "homebase-backup";
const FORMAT_VERSION = 1;

interface SecretsBlob { kdf: "scrypt-aes-256-gcm"; salt: string; iv: string; tag: string; data: string }
interface BackupIntegration { id: string; type: string; name: string; url: string; intervalSeconds: number; enabled: boolean; insecureTls: boolean }
interface BackupCamera { id: string; name: string; main: string; sub: string }
export interface BackupFile {
  format: typeof BACKUP_FORMAT; formatVersion: number; app: { version: string; commit: string }; createdAt: string;
  settings: Record<string, unknown>; dashboard: { tabs: TabDoc[] }; integrations: BackupIntegration[]; cameras: BackupCamera[]; secrets: SecretsBlob | null;
}
interface SecretsPlain { integrations: Record<string, string>; cameras: Record<string, { main: string; sub: string }> }

const keyOf = (pass: string, salt: Buffer) => scryptSync(pass, salt, 32);
function sealSecrets(pass: string, plain: SecretsPlain): SecretsBlob {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(pass, salt), iv);
  const data = Buffer.concat([c.update(JSON.stringify(plain), "utf8"), c.final()]);
  return { kdf: "scrypt-aes-256-gcm", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}
function openSecrets(pass: string, blob: SecretsBlob): SecretsPlain {
  try {
    const d = createDecipheriv("aes-256-gcm", keyOf(pass, Buffer.from(blob.salt, "base64")), Buffer.from(blob.iv, "base64"));
    d.setAuthTag(Buffer.from(blob.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.data, "base64")), d.final()]).toString("utf8")) as SecretsPlain;
  } catch { throw new ValidationError("That passphrase does not open this backup"); }
}

export function exportBackup(deps: Deps, passphrase: string): BackupFile {
  const { db, store } = deps;
  const secrets: SecretsPlain = { integrations: {}, cameras: {} };
  const integrations: BackupIntegration[] = store.listIntegrations().map(r => {
    try { if (store.apiKeyOf(r)) secrets.integrations[r.id] = store.apiKeyOf(r); } catch { /* unreadable key: restore will ask for it again */ }
    return { id: r.id, type: r.type, name: r.name, url: r.url, intervalSeconds: r.interval_s, enabled: Boolean(r.enabled), insecureTls: Boolean(r.insecure_tls) };
  });
  const cameras: BackupCamera[] = [];
  for (const { id } of store.listCameras()) {
    const cam = store.getCamera(id);
    if (!cam) continue;
    secrets.cameras[id] = { main: cam.main, sub: cam.sub };
    cameras.push({ id, name: cam.name, main: maskUrlSecret(cam.main), sub: maskUrlSecret(cam.sub) });
  }
  const v = versionInfo();
  return {
    format: BACKUP_FORMAT, formatVersion: FORMAT_VERSION, app: { version: v.version, commit: v.commit }, createdAt: new Date().toISOString(),
    settings: { ...getSettings(db) }, dashboard: { tabs: readDashboard(db).tabs }, integrations, cameras,
    secrets: passphrase ? sealSecrets(passphrase, secrets) : null
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/, CAM_ID = /^[A-Za-z0-9]{1,40}$/;

/** Checks the shape of an uploaded file before anything is touched. */
export function parseBackup(raw: unknown): BackupFile {
  const f = raw as Partial<BackupFile> | null;
  if (!f || typeof f !== "object" || f.format !== BACKUP_FORMAT) throw new ValidationError("This is not a Homebase backup file");
  if (typeof f.formatVersion !== "number" || f.formatVersion > FORMAT_VERSION) throw new ValidationError("This backup was made by a newer Homebase. Update first, then import it");
  const dash = validateDashboard(f.dashboard);
  const integrations = (Array.isArray(f.integrations) ? f.integrations : []).map((i: any): BackupIntegration => {
    if (!ID.test(String(i?.id))) throw new ValidationError("A connection in the file has an invalid id");
    if (!INTEGRATION_TYPES[String(i.type)]) throw new ValidationError(`The file has a connection of an unknown type "${String(i.type).slice(0, 30)}"`);
    return { id: String(i.id), type: String(i.type), name: String(i.name ?? "").trim().slice(0, 60) || INTEGRATION_TYPES[i.type].name, url: normalizeUrl(String(i.url ?? "")), intervalSeconds: Math.max(5, Math.min(3600, Math.round(Number(i.intervalSeconds)) || 15)), enabled: Boolean(i.enabled), insecureTls: Boolean(i.insecureTls) };
  });
  const cameras = (Array.isArray(f.cameras) ? f.cameras : []).map((c: any): BackupCamera => {
    if (!CAM_ID.test(String(c?.id))) throw new ValidationError("A camera in the file has an invalid id");
    return { id: String(c.id), name: String(c.name ?? "").trim().slice(0, 60) || "Camera", main: String(c.main ?? "").slice(0, 600), sub: String(c.sub ?? "").slice(0, 600) };
  });
  const s = f.secrets as SecretsBlob | null | undefined;
  if (s && !(typeof s.salt === "string" && typeof s.iv === "string" && typeof s.tag === "string" && typeof s.data === "string")) throw new ValidationError("The protected section of the file is damaged");
  return {
    format: BACKUP_FORMAT, formatVersion: f.formatVersion, app: { version: String(f.app?.version ?? "?"), commit: String(f.app?.commit ?? "?") }, createdAt: String(f.createdAt ?? ""),
    settings: f.settings && typeof f.settings === "object" ? f.settings : {}, dashboard: dash, integrations, cameras, secrets: s ?? null
  };
}

export interface ImportOptions { mode: "replace" | "merge"; passphrase?: string; skipSecrets?: boolean }

/** What an import would do, without changing anything. */
export function previewBackup(deps: Deps, file: BackupFile, opts: ImportOptions) {
  const haveInt = new Set(deps.store.listIntegrations().map(i => i.id)), haveCam = new Set(deps.store.listCameras().map(c => c.id));
  const haveTab = new Set(readDashboard(deps.db).tabs.map(t => t.id));
  const groups = file.dashboard.tabs.reduce((n, t) => n + t.groups.length, 0), tiles = file.dashboard.tabs.reduce((n, t) => n + t.groups.reduce((m, g) => m + g.tiles.length, 0), 0);
  let passphraseOk: boolean | null = null;
  if (file.secrets && opts.passphrase) { try { openSecrets(opts.passphrase, file.secrets); passphraseOk = true; } catch { passphraseOk = false; } }
  const replace = opts.mode === "replace";
  return {
    createdAt: file.createdAt, app: file.app, encrypted: Boolean(file.secrets), passphraseOk,
    tabs: file.dashboard.tabs.length, groups, tiles, integrations: file.integrations.length, cameras: file.cameras.length,
    adds: {
      tabs: replace ? file.dashboard.tabs.length : file.dashboard.tabs.filter(t => !haveTab.has(t.id)).length,
      integrations: replace ? file.integrations.length : file.integrations.filter(i => !haveInt.has(i.id)).length,
      cameras: replace ? file.cameras.length : file.cameras.filter(c => !haveCam.has(c.id)).length
    },
    removes: replace ? { integrations: haveInt.size, cameras: haveCam.size, tabs: haveTab.size } : null
  };
}

export async function applyBackup(deps: Deps, file: BackupFile, opts: ImportOptions, actor: string) {
  const { db, store, poller, go2rtc, shares } = deps;
  let secrets: SecretsPlain = { integrations: {}, cameras: {} };
  if (file.secrets && !opts.skipSecrets) {
    if (!opts.passphrase) throw new ValidationError("This backup is protected. Enter its passphrase, or choose to import without the saved passwords and keys");
    secrets = openSecrets(opts.passphrase, file.secrets);
  }
  const replace = opts.mode === "replace";
  if (replace) { try { deps.backups.create("before-import"); } catch { /* keep going: the import itself is validated already */ } }

  const oldInt = store.listIntegrations().map(i => i.id), oldCam = store.listCameras().map(c => c.id);
  const needsSecrets: string[] = [];
  const added = { integrations: 0, cameras: 0, tabs: 0 }, skipped = { integrations: 0, cameras: 0, tabs: 0 };
  const intIds = new Set<string>(), camIds = new Set<string>();

  tx(db, () => {
    if (replace) { db.exec("DELETE FROM integrations; DELETE FROM metrics; DELETE FROM cameras;"); }
    const haveInt = new Set(store.listIntegrations().map(i => i.id)), haveCam = new Set(store.listCameras().map(c => c.id));
    for (const i of file.integrations) {
      if (haveInt.has(i.id)) { skipped.integrations++; continue; }
      const key = secrets.integrations[i.id] ?? "";
      if (!key) needsSecrets.push(`${i.name} (API key)`);
      // Without its key a connection would only produce errors, so it is added switched off.
      store.importIntegration({ ...i, apiKey: key, enabled: key ? i.enabled : false });
      intIds.add(i.id); added.integrations++;
    }
    for (const c of file.cameras) {
      if (haveCam.has(c.id)) { skipped.cameras++; continue; }
      const real = secrets.cameras[c.id];
      const main = real?.main ?? c.main, sub = real?.sub ?? c.sub;
      if (main.includes(`:${MASK}@`) || sub.includes(`:${MASK}@`)) needsSecrets.push(`${c.name} (camera password)`);
      store.importCamera({ id: c.id, name: c.name, main, sub });
      camIds.add(c.id); added.cameras++;
    }
  });

  const current = readDashboard(db);
  let tabs: TabDoc[];
  if (replace) { tabs = file.dashboard.tabs; added.tabs = tabs.length; }
  else {
    const have = new Set(current.tabs.map(t => t.id));
    const fresh = file.dashboard.tabs.filter(t => !have.has(t.id));
    added.tabs = fresh.length; skipped.tabs = file.dashboard.tabs.length - fresh.length;
    tabs = [...current.tabs, ...fresh];
  }
  if (replace || added.tabs) writeDashboard(db, validateDashboard({ tabs }), current.revision);

  const known: Record<string, unknown> = {}, defaults = DEFAULTS() as unknown as Record<string, unknown>;
  if (replace) for (const k of Object.keys(file.settings)) if (k in defaults) known[k] = file.settings[k];
  try { updateSettings(db, known); } catch { /* a bad value in the file leaves the current settings alone */ }

  if (replace) {
    const keep = new Set(store.listCameras().map(c => c.id));
    for (const id of oldCam) if (!keep.has(id)) shares.forgetCamera(id);
  }
  for (const id of new Set([...oldInt, ...intIds])) poller.reload(id);
  await go2rtc.reconcile().catch(() => {});
  logEvent(db, "info", "backup", `${actor} imported a backup (${opts.mode}): ${added.tabs} tab(s), ${added.integrations} connection(s), ${added.cameras} camera(s) added${needsSecrets.length ? `; ${needsSecrets.length} still need a password or key` : ""}`);
  return { mode: opts.mode, added, skipped, needsSecrets };
}

// ---- automatic SQLite snapshots

const SNAP = /^homebase-\d{8}-\d{6}(-[a-z-]{1,20})?\.db$/;
export const validSnapshotName = (n: string) => SNAP.test(n);

export class AutoBackup {
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  readonly dir: string;
  constructor(private deps: () => Deps, dataDir: string) { this.dir = join(dataDir, "backups"); }

  list(): Array<{ name: string; size: number; ts: number; auto: boolean }> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter(n => SNAP.test(n)).map(name => {
      const st = statSync(join(this.dir, name));
      return { name, size: st.size, ts: st.mtimeMs, auto: !/-[a-z-]+\.db$/.test(name) };
    }).sort((a, b) => b.ts - a.ts);
  }

  /** A consistent copy of the whole database (VACUUM INTO is safe while the app is running). */
  create(label = ""): { name: string; size: number } {
    mkdirSync(this.dir, { recursive: true });
    const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const base = `homebase-${stamp}${label ? `-${label}` : ""}`;
    let name = `${base}.db`;
    for (let n = 0; existsSync(join(this.dir, name)); n++) name = `${base}-${"abcdefghijklmnopqrstuvwxyz"[n % 26]}.db`;
    this.deps().db.exec(`VACUUM INTO '${join(this.dir, name).replace(/'/g, "''")}'`);
    return { name, size: statSync(join(this.dir, name)).size };
  }

  remove(name: string): boolean {
    if (!SNAP.test(name) || !existsSync(join(this.dir, name))) return false;
    unlinkSync(join(this.dir, name));
    return true;
  }

  /** Keep the newest N automatic snapshots and the last 5 safety copies made before imports. */
  prune(keep: number): number {
    const all = this.list(), doomed = [...all.filter(s => s.auto).slice(keep), ...all.filter(s => !s.auto).slice(5)];
    for (const s of doomed) this.remove(s.name);
    return doomed.length;
  }

  tick(): void {
    const { db } = this.deps();
    const s = getSettings(db);
    if (!s.autoBackup) return;
    const newest = this.list().find(x => x.auto);
    if (newest && Date.now() - newest.ts < 24 * 3600_000) return;
    try {
      const made = this.create();
      this.prune(s.backupKeep);
      logEvent(db, "info", "backup", `Nightly backup saved (${Math.max(1, Math.round(made.size / 1024))} KB)`);
    } catch (error) { logEvent(db, "error", "backup", `Nightly backup failed: ${error instanceof Error ? error.message : error}`); }
  }

  start(): void {
    this.first = setTimeout(() => this.tick(), 60_000); this.first.unref();
    this.timer = setInterval(() => this.tick(), 3600_000); this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }
}
