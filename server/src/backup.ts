import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MASK, maskUrlSecret } from "./crypto.js";
import { ValidationError, readDashboard, validateDashboard, writeDashboard, type TabDoc } from "./dashboard.js";
import { getMeta, logEvent, setMeta, snapshotInto, tx } from "./db.js";
import { INTEGRATION_TYPES } from "./integrations/registry.js";
import { normalizeUrl } from "./integrations/http.js";
import { cleanSelection } from "./integrations/unificatalog.js";
import { cleanOpenMode, cleanOpenUrl } from "./openaddr.js";
import { DEFAULTS, getSettings, updateSettings } from "./settings.js";
import { checkImage, cleanIcon, cleanIconRef } from "./icons.js";
import { referencedIcons } from "./iconuse.js";
import { versionInfo } from "./version.js";
import { cleanMonitor, exportMonitors, type MonitorConfig } from "./monitors.js";
import { finish, verifyDatabaseFile, type Check, type VerifyReport } from "./verify.js";
import type { Deps } from "./deps.js";

export const BACKUP_FORMAT = "homebase-backup";
const FORMAT_VERSION = 1;

interface SecretsBlob { kdf: "scrypt-aes-256-gcm"; salt: string; iv: string; tag: string; data: string }
interface BackupIntegration { id: string; type: string; name: string; url: string; intervalSeconds: number; enabled: boolean; insecureTls: boolean; icon?: string; iconRef?: string; openUrl?: string; openMode?: string; fields?: Array<{ path: string; label: string; unit: string }> }
interface BackupCamera { id: string; name: string; main: string; sub: string; icon?: string; iconRef?: string }
export interface BackupFile {
  format: typeof BACKUP_FORMAT; formatVersion: number; app: { version: string; commit: string }; createdAt: string;
  settings: Record<string, unknown>; dashboard: { tabs: TabDoc[] }; integrations: BackupIntegration[]; cameras: BackupCamera[]; secrets: SecretsBlob | null;
  /** True when the protected section also carries the accounts (names, roles and password hashes). */
  accountsIncluded?: boolean;
  /** The saved icon files the rest of the file refers to, by name ("used/..."), as base64. */
  icons?: Record<string, string>;
  /** Uptime monitors and public status pages (no history, and status page links are made new on import). */
  monitors?: Array<MonitorConfig & { secretsOmitted?: boolean }>;
  statusPages?: Array<{ id: string; title: string; message: string; tone?: string; domain?: string; monitors: string[]; enabled: boolean; incidents?: Array<{ title: string; body: string; style: string; pinned: boolean; resolved: boolean }> }>;
}
type AccountRow = Record<string, string | number | null>;
interface SecretsPlain { integrations: Record<string, string>; cameras: Record<string, { main: string; sub: string }>; accounts?: AccountRow[] }

const keyOf = (pass: string, salt: Buffer) => scryptSync(pass, salt, 32);
export function sealSecrets(pass: string, plain: SecretsPlain): SecretsBlob {
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

export function exportBackup(deps: Deps, passphrase: string, opts: { accounts?: boolean } = {}): BackupFile {
  if (opts.accounts && !passphrase) throw new ValidationError("Accounts can only be included together with a passphrase, because they contain password hashes");
  const { db, store } = deps;
  const secrets: SecretsPlain = { integrations: {}, cameras: {} };
  const integrations: BackupIntegration[] = store.listIntegrations().map(r => {
    try { if (store.apiKeyOf(r)) secrets.integrations[r.id] = store.apiKeyOf(r); } catch { /* unreadable key: restore will ask for it again */ }
    return { id: r.id, type: r.type, name: r.name, url: r.url, intervalSeconds: r.interval_s, enabled: Boolean(r.enabled), insecureTls: Boolean(r.insecure_tls), icon: r.icon, iconRef: r.icon_ref, openUrl: r.open_url, openMode: r.open_mode === "inapp" ? "inapp" : "tab", fields: store.fieldsOf(r) };
  });
  const cameras: BackupCamera[] = [];
  for (const { id, icon, iconRef } of store.listCameras()) {
    const cam = store.getCamera(id);
    if (!cam) continue;
    secrets.cameras[id] = { main: cam.main, sub: cam.sub };
    cameras.push({ id, name: cam.name, main: maskUrlSecret(cam.main), sub: maskUrlSecret(cam.sub), icon, iconRef });
  }
  if (opts.accounts) {
    // A two-factor secret is sealed with this install's key in the database; inside the passphrase-protected section it travels as plain text so it can be re-sealed anywhere.
    secrets.accounts = (db.prepare("SELECT * FROM users ORDER BY created_at").all() as unknown as AccountRow[]).map(r => {
      if (r.totp_secret) { try { return { ...r, totp_secret: deps.box.open(String(r.totp_secret)) }; } catch { return { ...r, totp_secret: "", totp_enabled: 0 }; } }
      return { ...r };
    });
  }
  const v = versionInfo();
  // The icon pictures travel inside the file (up to 6 MB of them), so a restore on a new machine does not lose them.
  const icons: Record<string, string> = {}; let iconBytes = 0;
  for (const name of referencedIcons(db)) {
    if (!name.startsWith("used/")) continue;
    const file = deps.icons.file(name); if (!file) continue;
    const buf = readFileSync(file);
    if (iconBytes + buf.length > 6_000_000) break;
    iconBytes += buf.length; icons[name] = buf.toString("base64");
  }
  const { monitors, statusPages } = exportMonitors(deps.monitors, db);
  return {
    icons, monitors, statusPages,
    accountsIncluded: Boolean(opts.accounts),
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
    return { id: String(i.id), type: String(i.type), name: String(i.name ?? "").trim().slice(0, 60) || INTEGRATION_TYPES[i.type].name, url: normalizeUrl(String(i.url ?? "")), intervalSeconds: Math.max(5, Math.min(3600, Math.round(Number(i.intervalSeconds)) || 15)), enabled: Boolean(i.enabled), insecureTls: Boolean(i.insecureTls), icon: cleanIcon(i.icon), iconRef: cleanIcon(i.icon) ? cleanIconRef(i.iconRef) : "", openUrl: (() => { try { return cleanOpenUrl(i.openUrl); } catch { return ""; } })(), openMode: cleanOpenMode(i.openMode), fields: cleanSelection(i.fields) };
  });
  const cameras = (Array.isArray(f.cameras) ? f.cameras : []).map((c: any): BackupCamera => {
    if (!CAM_ID.test(String(c?.id))) throw new ValidationError("A camera in the file has an invalid id");
    return { id: String(c.id), name: String(c.name ?? "").trim().slice(0, 60) || "Camera", main: String(c.main ?? "").slice(0, 600), sub: String(c.sub ?? "").slice(0, 600), icon: cleanIcon(c.icon), iconRef: cleanIcon(c.icon) ? cleanIconRef(c.iconRef) : "" };
  });
  const monitors = (Array.isArray(f.monitors) ? f.monitors : []).slice(0, 100).map((m: any, i: number): MonitorConfig & { secretsOmitted?: boolean } => {
    if (!ID.test(String(m?.id))) throw new ValidationError("A monitor in the file has an invalid id");
    const { authPass: _p, conn: _c, ...c } = cleanMonitor({ ...m, authPass: "", conn: "" }, undefined, true);
    return { ...c, hasAuthPass: false, hasConn: false, id: String(m.id), position: i, secretsOmitted: Boolean(m.secretsOmitted) };
  });
  // A group inside the file must exist, be a group, and not lead back to itself.
  const byId = new Map(monitors.map(m => [m.id, m]));
  for (const m of monitors) {
    const p = m.parentId ? byId.get(m.parentId) : undefined;
    if (!p || p.kind !== "group" || p.id === m.id) { m.parentId = ""; continue; }
    let cur: typeof m | undefined = p, n = 0;
    while (cur && cur.parentId && n++ < 12) cur = byId.get(cur.parentId);
    if (cur && cur.parentId) m.parentId = "";
  }
  const monIds = new Set(monitors.map(m => m.id));
  const statusPages = (Array.isArray(f.statusPages) ? f.statusPages : []).slice(0, 50).map((p: any) => ({
    id: String(p?.id ?? "").slice(0, 64), title: String(p?.title ?? "Status").trim().slice(0, 80) || "Status", message: String(p?.message ?? "").slice(0, 400), tone: ["info", "warn", "bad"].includes(p?.tone) ? p.tone : "info", domain: String(p?.domain ?? "").slice(0, 253),
    incidents: (Array.isArray(p?.incidents) ? p.incidents : []).slice(0, 100).map((i: any) => ({ title: String(i?.title ?? "").slice(0, 120), body: String(i?.body ?? "").slice(0, 2000), style: String(i?.style ?? "info"), pinned: i?.pinned !== false, resolved: Boolean(i?.resolved) })).filter((i: { title: string }) => i.title),
    monitors: (Array.isArray(p?.monitors) ? p.monitors.map(String) : []).filter((x: string) => monIds.has(x)), enabled: p?.enabled !== false
  })).filter(p => p.monitors.length);
  const s = f.secrets as SecretsBlob | null | undefined;
  if (s && !(typeof s.salt === "string" && typeof s.iv === "string" && typeof s.tag === "string" && typeof s.data === "string")) throw new ValidationError("The protected section of the file is damaged");
  return {
    format: BACKUP_FORMAT, formatVersion: f.formatVersion, app: { version: String(f.app?.version ?? "?"), commit: String(f.app?.commit ?? "?") }, createdAt: String(f.createdAt ?? ""),
    settings: f.settings && typeof f.settings === "object" ? f.settings : {}, dashboard: dash, integrations, cameras, secrets: s ?? null,
    accountsIncluded: Boolean(f.accountsIncluded && s),
    icons: parseIcons(f.icons), monitors, statusPages
  };
}

const ICON_NAME = /^used\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:svg|png|jpg|gif|webp)$/;
/** The pictures in a file, checked one by one; anything that is not a safe image of a known name is dropped. */
function parseIcons(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, data] of Object.entries(raw as Record<string, unknown>).slice(0, 400)) {
    if (!ICON_NAME.test(name) || typeof data !== "string") continue;
    try { const buf = Buffer.from(data, "base64"); checkImage(buf, [name.split(".").pop()!]); out[name] = data; } catch { /* not a usable picture */ }
  }
  return out;
}

export interface ImportOptions { mode: "replace" | "merge"; passphrase?: string; skipSecrets?: boolean; restoreAccounts?: boolean; actorId?: string }

/** What an import would do, without changing anything. */
export function previewBackup(deps: Deps, file: BackupFile, opts: ImportOptions) {
  const haveInt = new Set(deps.store.listIntegrations().map(i => i.id)), haveCam = new Set(deps.store.listCameras().map(c => c.id));
  const haveTab = new Set(readDashboard(deps.db).tabs.map(t => t.id));
  const groups = file.dashboard.tabs.reduce((n, t) => n + t.groups.length, 0), tiles = file.dashboard.tabs.reduce((n, t) => n + t.groups.reduce((m, g) => m + g.tiles.length, 0), 0);
  let passphraseOk: boolean | null = null;
  if (file.secrets && opts.passphrase) { try { openSecrets(opts.passphrase, file.secrets); passphraseOk = true; } catch { passphraseOk = false; } }
  const replace = opts.mode === "replace";
  let accounts: { included: boolean; count: number | null; youWillBeSignedOut: boolean } = { included: Boolean(file.accountsIncluded), count: null, youWillBeSignedOut: false };
  if (file.accountsIncluded && file.secrets && passphraseOk) {
    const rows = openSecrets(opts.passphrase!, file.secrets).accounts ?? [];
    accounts = { included: true, count: rows.length, youWillBeSignedOut: Boolean(opts.restoreAccounts && replace) };
  }
  return {
    accounts,
    createdAt: file.createdAt, app: file.app, encrypted: Boolean(file.secrets), passphraseOk,
    tabs: file.dashboard.tabs.length, groups, tiles, integrations: file.integrations.length, cameras: file.cameras.length, monitors: (file.monitors ?? []).length, icons: Object.keys(file.icons ?? {}).length,
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
  let accountRows: AccountRow[] | null = null;
  if (opts.restoreAccounts) {
    if (!file.accountsIncluded || !secrets.accounts) throw new ValidationError("This file does not contain accounts");
    accountRows = checkAccounts(secrets.accounts, replace);
  }
  if (replace || accountRows) { try { deps.backups.create("before-import"); } catch { /* keep going: the import itself is validated already */ } }

  // The pictures first, so nothing that refers to one is ever without it. A merge keeps pictures that are already here.
  let iconsWritten = 0;
  for (const [name, data] of Object.entries(file.icons ?? {})) {
    const target = deps.icons.usedPath(name);
    if (!replace && existsSync(target)) continue;
    mkdirSync(deps.icons.usedDir, { recursive: true });
    writeFileSync(target, Buffer.from(data, "base64")); iconsWritten++;
  }
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
      store.importCamera({ id: c.id, name: c.name, main, sub, icon: c.icon, iconRef: c.iconRef });
      camIds.add(c.id); added.cameras++;
    }
  });

  // Uptime monitors and status pages. Their history is not part of a backup file, and status page links are new.
  let monitorsAdded = 0;
  if ((file.monitors ?? []).length || replace) {
    const haveMon = new Set(deps.monitors.list().map(m => m.id));
    tx(db, () => {
      if (replace) { deps.monitors.clearAll(); db.exec("DELETE FROM status_pages;"); haveMon.clear(); }
      for (const m of file.monitors ?? []) { if (haveMon.has(m.id)) continue; const { secretsOmitted, ...c } = m; deps.monitors.insert({ ...c, authPass: "", conn: "" }); monitorsAdded++; if (secretsOmitted) needsSecrets.push(`${m.name} (monitor password, headers or push address)`); }
    });
    const have = new Set(deps.monitors.list().map(m => m.id));
    for (const p of file.statusPages ?? []) {
      const ids = p.monitors.filter(x => have.has(x));
      if (!ids.length) continue;
      try {
        let made;
        try { made = deps.statusPages.create({ title: p.title, message: p.message, tone: p.tone, domain: p.domain, monitors: ids, enabled: p.enabled }); }
        catch { made = deps.statusPages.create({ title: p.title, message: p.message, tone: p.tone, monitors: ids, enabled: p.enabled }); } // the domain is taken: keep the page without it
        for (const i of p.incidents ?? []) deps.statusPages.createIncident(made.id, i);
      } catch { /* a page that cannot be made is left out */ }
    }
    for (const m of deps.monitors.list()) deps.monitors.update(m.id, {}); // restarts each one's schedule
  }

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

  let accountsResult: { added: number; removed: number; signedOut: boolean } | null = null;
  if (accountRows) accountsResult = applyAccounts(deps, accountRows, replace, opts.actorId ?? "");

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
  if (accountsResult) logEvent(db, "warn", "security", `${actor} restored accounts from a backup (${opts.mode}): ${accountsResult.added} added, ${accountsResult.removed} removed`);
  return { mode: opts.mode, added: { ...added, monitors: monitorsAdded }, skipped, needsSecrets, accounts: accountsResult, icons: iconsWritten };
}

const ROLE = new Set(["admin", "viewer"]);
/** Checks the accounts in a file before anything is changed. */
function checkAccounts(rows: unknown, replace: boolean): AccountRow[] {
  if (!Array.isArray(rows)) throw new ValidationError("The accounts in the file are damaged");
  const ids = new Set<string>(), names = new Set<string>();
  const out = rows.map((r: any): AccountRow => {
    const id = String(r?.id ?? ""), username = String(r?.username ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || username.length < 1 || username.length > 60 || !ROLE.has(String(r?.role)) || typeof r?.pass_hash !== "string" || !r.pass_hash) throw new ValidationError("An account in the file is damaged");
    if (ids.has(id) || names.has(username.toLowerCase())) throw new ValidationError("The file lists the same account twice");
    ids.add(id); names.add(username.toLowerCase());
    return { ...r, id, username } as AccountRow;
  });
  if (replace && !out.some(r => r.role === "admin" && !r.disabled)) throw new ValidationError("The accounts in the file have no active administrator, so nobody could sign in afterwards");
  return out;
}

/** Puts the file's accounts in place. Columns are copied generically so later account features (two-factor, etc.) come along. */
function applyAccounts(deps: Deps, rows: AccountRow[], replace: boolean, actorId: string) {
  const { db } = deps;
  const cols = (db.prepare("PRAGMA table_info(users)").all() as unknown as Array<{ name: string }>).map(c => c.name);
  let added = 0, removed = 0, signedOut = false;
  const val = (r: AccountRow, c: string) => (c === "totp_secret" && r[c] ? deps.box.seal(String(r[c])) : r[c]) as string | number | null;
  tx(db, () => {
    const have = db.prepare("SELECT id, username FROM users").all() as unknown as Array<{ id: string; username: string }>;
    if (replace) {
      const keep = new Set(rows.map(r => r.id as string));
      for (const u of have.filter(x => !keep.has(x.id))) {
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
        db.prepare("DELETE FROM users WHERE id = ?").run(u.id); removed++;
        if (u.id === actorId) signedOut = true;
      }
    }
    const ids = new Set(have.map(u => u.id)), names = new Set(have.map(u => u.username.toLowerCase()));
    for (const r of rows) {
      const use = cols.filter(c => c in r);
      const vals = use.map(c => val(r, c));
      if (replace && ids.has(r.id as string)) {
        const set = use.filter(c => c !== "id");
        db.prepare(`UPDATE users SET ${set.map(c => `${c} = ?`).join(", ")} WHERE id = ?`).run(...set.map(c => val(r, c)), r.id as string);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(r.id as string); // sign-ins made before the restore must not outlive a changed password
        if (r.id === actorId) signedOut = true;
      } else if (!ids.has(r.id as string) && !names.has(String(r.username).toLowerCase())) {
        db.prepare(`INSERT INTO users (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`).run(...vals); added++;
      }
    }
  });
  return { added, removed, signedOut };
}

// ---- checking a JSON backup file without importing it

export function verifyJsonBackup(deps: Deps, raw: unknown, passphrase: string, size: number): VerifyReport {
  const checks: Check[] = [], counts: Record<string, number> = {};
  const add = (id: string, label: string, status: Check["status"], detail: string) => checks.push({ id, label, status, detail });
  let file: BackupFile;
  try { file = parseBackup(raw); add("structure", "File structure", "pass", `A Homebase backup (format ${file.formatVersion}) made by version ${file.app.version}. Every tab, tile and connection in it is valid.`); }
  catch (error) { add("structure", "File structure", "fail", error instanceof Error ? error.message : "The file could not be read"); return finish("json", checks, counts, size, null, null); }
  const tiles = file.dashboard.tabs.reduce((n, t) => n + t.groups.reduce((m, g) => m + g.tiles.length, 0), 0);
  Object.assign(counts, { tabs: file.dashboard.tabs.length, tiles, connections: file.integrations.length, cameras: file.cameras.length });
  add("counts", "What it contains", "pass", `${counts.tabs} tab(s), ${tiles} tile(s), ${counts.connections} connection(s), ${counts.cameras} camera(s).`);
  {
    const wanted = new Set<string>();
    const note = (v: unknown) => { if (typeof v === "string" && v.startsWith("used/")) wanted.add(v.split("?")[0]); };
    for (const t of file.dashboard.tabs) { note(t.icon); for (const g of t.groups) for (const tile of g.tiles) { const c = tile.config as { icon?: string; items?: Array<{ icon?: string }> }; note(c.icon); for (const it of Array.isArray(c.items) ? c.items : []) note(it?.icon); } }
    for (const x of [...file.integrations, ...file.cameras]) note(x.icon);
    counts.icons = Object.keys(file.icons ?? {}).length;
    const missing = [...wanted].filter(n => !(file.icons ?? {})[n]);
    if (!wanted.size) add("icons", "Icons", "pass", "No saved icons are used.");
    else if (!missing.length) add("icons", "Icons", "pass", `All ${wanted.size} icon(s) the file uses are inside it.`);
    else add("icons", "Icons", "warn", `${missing.length} of ${wanted.size} icon(s) the file uses are not inside it, so those show letters until they are chosen again.`);
  }
  const created = Date.parse(file.createdAt);
  if (file.secrets) {
    if (!passphrase) add("secrets", "Saved passwords and keys", "warn", "This file is protected. Enter its passphrase to check that it opens.");
    else {
      try {
        const plain = openSecrets(passphrase, file.secrets);
        const keys = Object.keys(plain.integrations).length, cams = Object.keys(plain.cameras).length;
        add("secrets", "Saved passwords and keys", "pass", `The passphrase opens the protected section: ${keys} API key(s) and ${cams} camera login(s).`);
        const missing = file.integrations.filter(i => !plain.integrations[i.id]).length;
        if (missing) add("keys", "Every connection has its key", "warn", `${missing} connection(s) have no saved key and will need one entered after restoring.`);
        if (file.accountsIncluded) {
          const rows = plain.accounts ?? [];
          counts.accounts = rows.length;
          try { checkAccounts(rows, true); add("accounts", "Accounts", "pass", `${rows.length} account(s) are included and at least one active administrator is among them.`); }
          catch (e) { add("accounts", "Accounts", "fail", e instanceof Error ? e.message : "The accounts are damaged"); }
        }
      } catch (error) { add("secrets", "Saved passwords and keys", "fail", error instanceof Error ? error.message : "That passphrase does not open this backup"); }
    }
  } else add("secrets", "Saved passwords and keys", "warn", "No passwords or keys are inside this file (it was exported without a passphrase), so you would enter them again after restoring.");
  return finish("json", checks, counts, size, Number.isFinite(created) ? created : null, null);
}

// ---- automatic SQLite snapshots

const SNAP = /^homebase-\d{8}-\d{6}(-[a-z-]{1,20})?\.db$/;
export const validSnapshotName = (n: string) => SNAP.test(n);

// ---- schedule maths (all in the dashboard's time zone)

export function zonedParts(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(ts)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return p;
}
const offsetAt = (ts: number, tz: string) => { const p = zonedParts(ts, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000; };
function zonedToEpoch(y: number, mo: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  return guess - offsetAt(guess - offsetAt(guess, tz), tz);
}
/** The wall-clock time `hh:mm` on the day that is `days` away from `ts` (in time zone tz), as an epoch. */
function slotOnDay(ts: number, days: number, hh: number, mm: number, tz: string): { at: number; weekday: number } {
  const p = zonedParts(ts, tz), day = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { at: zonedToEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz), weekday: day.getUTCDay() };
}
export interface Schedule { backupEvery: "6h" | "daily" | "weekly"; backupTime: string; backupDay: number; timezone: string }
/** The most recent moment a scheduled copy should have been made (at or before `now`). */
export function lastSlot(now: number, s: Schedule): number {
  const [hh, mm] = s.backupTime.split(":").map(Number);
  for (let k = 0; k <= 8; k++) {
    const c = slotOnDay(now, -k, hh, mm, s.timezone);
    if (c.at <= now && (s.backupEvery !== "weekly" || c.weekday === s.backupDay)) return c.at;
  }
  return now;
}
/** When the next scheduled copy is due, given the newest automatic copy. */
export function nextSlot(now: number, s: Schedule, newest: number | null): number {
  if (!newest) return now;
  if (s.backupEvery === "6h") return Math.max(now, newest + 6 * 3600_000);
  const [hh, mm] = s.backupTime.split(":").map(Number);
  for (let k = 0; k <= 8; k++) {
    const c = slotOnDay(now, k, hh, mm, s.timezone);
    if (c.at > now && c.at > newest && (s.backupEvery !== "weekly" || c.weekday === s.backupDay)) return c.at;
  }
  return now + 24 * 3600_000;
}
export function isDue(now: number, s: Schedule, newest: number | null): boolean {
  if (!newest) return true;
  if (s.backupEvery === "6h") return now - newest >= 6 * 3600_000;
  return lastSlot(now, s) > newest;
}

export interface VerifyNote { ts: number; ok: boolean; summary: string }

export class AutoBackup {
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private busy = false;
  readonly dir: string;
  readonly tmp: string;
  constructor(private deps: () => Deps, dataDir: string) { this.dir = join(dataDir, "backups"); this.tmp = join(dataDir, "tmp"); }

  list(): Array<{ name: string; size: number; ts: number; auto: boolean; verified: VerifyNote | null }> {
    if (!existsSync(this.dir)) return [];
    const notes = this.notes();
    return readdirSync(this.dir).filter(n => SNAP.test(n)).map(name => {
      const st = statSync(join(this.dir, name));
      return { name, size: st.size, ts: st.mtimeMs, auto: !/-[a-z-]+\.db$/.test(name), verified: notes[name] ?? null };
    }).sort((a, b) => b.ts - a.ts);
  }

  private notes(): Record<string, VerifyNote> {
    try { return JSON.parse(getMeta(this.deps().db, "backup_verify") ?? "{}"); } catch { return {}; }
  }
  private setNote(name: string, note: VerifyNote): void {
    const have = new Set(existsSync(this.dir) ? readdirSync(this.dir) : []);
    const all = Object.fromEntries(Object.entries(this.notes()).filter(([n]) => have.has(n)));
    all[name] = note;
    setMeta(this.deps().db, "backup_verify", JSON.stringify(all));
  }

  /** A consistent copy of the whole database (VACUUM INTO is safe while the app is running). */
  create(label = ""): { name: string; size: number } { return snapshotInto(this.deps().db, this.dir, label); }

  /** Opens a copy on a temporary duplicate and reports every check. The result is remembered so the list can show it. */
  verify(name: string): VerifyReport {
    const d = this.deps();
    const file = join(this.dir, name);
    const report = verifyDatabaseFile(file, d.box, this.tmp, null, { hasIcon: n => Boolean(d.icons.file(n)) });
    this.setNote(name, { ts: Date.now(), ok: report.ok, summary: report.summary });
    return report;
  }

  remove(name: string): boolean {
    if (!SNAP.test(name) || !existsSync(join(this.dir, name))) return false;
    unlinkSync(join(this.dir, name));
    return true;
  }

  /** Keep the newest N automatic snapshots and the last 5 safety copies made before imports and upgrades. */
  prune(keep: number): number {
    const all = this.list(), doomed = [...all.filter(s => s.auto).slice(keep), ...all.filter(s => !s.auto).slice(8)];
    for (const s of doomed) this.remove(s.name);
    return doomed.length;
  }

  nextAt(): number | null {
    const { db } = this.deps();
    const s = getSettings(db);
    if (!s.autoBackup) return null;
    return nextSlot(Date.now(), s, this.list().find(x => x.auto)?.ts ?? null);
  }

  /** Makes a scheduled copy if one is due: verifies it, logs the outcome and sends it to network destinations. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    const d = this.deps(), { db } = d;
    const s = getSettings(db);
    if (!s.autoBackup) return;
    if (!isDue(now, s, this.list().find(x => x.auto)?.ts ?? null)) return;
    this.busy = true;
    try {
      const made = this.create();
      const report = this.verify(made.name);
      this.prune(s.backupKeep);
      const kb = `${Math.max(1, Math.round(made.size / 1024))} KB`;
      if (report.ok) logEvent(db, "info", "backup", `Scheduled backup saved and verified (${kb}): ${report.summary}`);
      else logEvent(db, "error", "backup", `Scheduled backup saved (${kb}) but the check found a problem: ${report.summary}`);
      await d.destinations.sendAll(join(this.dir, made.name), made.name);
    } catch (error) { logEvent(db, "error", "backup", `Scheduled backup failed: ${error instanceof Error ? error.message : error}`); }
    finally { this.busy = false; }
  }

  start(): void {
    this.first = setTimeout(() => void this.tick(), 60_000); this.first.unref();
    this.timer = setInterval(() => void this.tick(), 60_000); this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }
}
