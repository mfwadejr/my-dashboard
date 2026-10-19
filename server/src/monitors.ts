import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { Resolver } from "node:dns/promises";
import { hashToken } from "./auth.js";
import type { SecretBox } from "./crypto.js";
import { ValidationError } from "./dashboard.js";
import { logEvent, type DB } from "./db.js";

// ---------------------------------------------------------------- shapes

export type MonitorKind = "http" | "keyword" | "tcp" | "dns";
export const MONITOR_KINDS: readonly MonitorKind[] = ["http", "keyword", "tcp", "dns"];
export type MonitorState = "up" | "down" | "pending" | "paused" | "unknown";

export interface MonitorConfig {
  id: string; name: string; kind: MonitorKind; target: string; port: number; keyword: string; invert: boolean; expect: string; method: "GET" | "HEAD";
  dnsType: string; dnsServer: string; intervalSeconds: number; timeoutSeconds: number; retries: number; insecureTls: boolean; certWarnDays: number; enabled: boolean; position: number;
}
interface Raw {
  id: string; name: string; kind: string; target: string; port: number; keyword: string; invert: number; expect: string; method: string; dns_type: string; dns_server: string;
  interval_s: number; timeout_s: number; retries: number; insecure_tls: number; cert_warn_days: number; enabled: number; position: number; cert_expires: number | null; created_at: number;
}
const COLS = "id, name, kind, target, port, keyword, invert, expect, method, dns_type, dns_server, interval_s, timeout_s, retries, insecure_tls, cert_warn_days, enabled, position, cert_expires, created_at";
const toConfig = (r: Raw): MonitorConfig => ({
  id: r.id, name: r.name, kind: (MONITOR_KINDS as readonly string[]).includes(r.kind) ? r.kind as MonitorKind : "http", target: r.target, port: r.port, keyword: r.keyword, invert: Boolean(r.invert),
  expect: r.expect, method: r.method === "HEAD" ? "HEAD" : "GET", dnsType: r.dns_type, dnsServer: r.dns_server, intervalSeconds: r.interval_s, timeoutSeconds: r.timeout_s, retries: r.retries,
  insecureTls: Boolean(r.insecure_tls), certWarnDays: r.cert_warn_days, enabled: Boolean(r.enabled), position: r.position
});

export interface CheckResult { up: boolean; ms: number | null; message: string; certExpires?: number | null }

// ---------------------------------------------------------------- validation

const HOST = /^[A-Za-z0-9._:-]{1,253}$/, RANGES = /^\d{3}(-\d{3})?(,\d{3}(-\d{3})?)*$/, DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"];
const int = (v: unknown, lo: number, hi: number, dflt: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== "" && v !== null && v !== undefined ? Math.max(lo, Math.min(hi, n)) : dflt; };

/** Turns what the form sent into a checked monitor, or says in plain words what is wrong. */
export function cleanMonitor(body: any, keep?: MonitorConfig): Omit<MonitorConfig, "id" | "position"> {
  const b = body ?? {};
  const kind = String(b.kind ?? keep?.kind ?? "http") as MonitorKind;
  if (!MONITOR_KINDS.includes(kind)) throw new ValidationError("Choose what to check: a website, a port or a DNS name");
  let target = String(b.target ?? "").trim(), port = 0;
  if (kind === "http" || kind === "keyword") {
    let u: URL;
    try { u = new URL(target); } catch { throw new ValidationError("Enter a full address such as https://example.com"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new ValidationError("The address must start with http:// or https://");
    if (target.length > 500) throw new ValidationError("That address is too long");
  } else {
    if (!HOST.test(target)) throw new ValidationError("Enter a host name or an IP address, for example 192.168.1.10 or nas.local");
    if (kind === "tcp") {
      port = Math.round(Number(b.port));
      if (!(port >= 1 && port <= 65535)) throw new ValidationError("Enter a port between 1 and 65535");
    }
  }
  const keyword = String(b.keyword ?? "").trim().slice(0, 200);
  if (kind === "keyword" && !keyword) throw new ValidationError("Enter the word or phrase that must (or must not) appear on the page");
  const expect = String(b.expect ?? "200-299").replace(/\s+/g, "") || "200-299";
  if (!RANGES.test(expect)) throw new ValidationError("Allowed status codes look like 200-299 or 200,301,404");
  const dnsType = String(b.dnsType ?? "A").toUpperCase();
  if (kind === "dns" && !DNS_TYPES.includes(dnsType)) throw new ValidationError("Choose a DNS record type");
  const dnsServer = String(b.dnsServer ?? "").trim();
  if (dnsServer && !/^[0-9a-fA-F:.]{3,45}$/.test(dnsServer)) throw new ValidationError("A DNS server is given as an IP address, for example 192.168.1.1");
  const name = String(b.name ?? "").trim() || (kind === "http" || kind === "keyword" ? new URL(target).host : kind === "tcp" ? `${target}:${port}` : target);
  if (name.length > 60) throw new ValidationError("The name is too long (60 characters at most)");
  const intervalSeconds = int(b.intervalSeconds, 20, 86400, keep?.intervalSeconds ?? 60);
  const timeoutSeconds = Math.min(int(b.timeoutSeconds, 1, 60, keep?.timeoutSeconds ?? 10), intervalSeconds);
  return {
    name, kind, target, port, keyword: kind === "keyword" || kind === "dns" ? keyword : "", invert: kind === "keyword" && Boolean(b.invert), expect,
    method: kind === "http" && String(b.method).toUpperCase() === "HEAD" ? "HEAD" : "GET", dnsType: kind === "dns" ? dnsType : "A", dnsServer: kind === "dns" ? dnsServer : "",
    intervalSeconds, timeoutSeconds, retries: int(b.retries, 0, 10, keep?.retries ?? 1), insecureTls: (kind === "http" || kind === "keyword") && Boolean(b.insecureTls),
    certWarnDays: int(b.certWarnDays, 0, 365, keep?.certWarnDays ?? 14), enabled: b.enabled === undefined ? (keep?.enabled ?? true) : Boolean(b.enabled)
  };
}

// ---------------------------------------------------------------- the checks themselves

const explain = (e: any, timeoutS: number): string => {
  const code = String(e?.code ?? "");
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || code === "ETIMEDOUT" || /timed out/i.test(String(e?.message))) return `Timed out after ${timeoutS} s`;
  if (code === "ECONNREFUSED") return "Connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Name not found";
  if (code === "ECONNRESET") return "Connection was reset";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "Host unreachable";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH|ERR_TLS/i.test(code)) return `Certificate problem: ${String(e.message).slice(0, 80)}`;
  return String(e?.message ?? "Failed").slice(0, 120);
};

const inRanges = (status: number, spec: string) => spec.split(",").some(p => { const [a, b] = p.split("-").map(Number); return status >= a && status <= (b ?? a); });

interface Once { status: number; location: string | null; body: string; certExpires: number | null }
function httpOnce(url: URL, o: { method: string; insecure: boolean; deadline: number; wantBody: boolean }): Promise<Once> {
  return new Promise((resolve, reject) => {
    const left = o.deadline - Date.now();
    if (left <= 0) { const e = new Error("timed out"); e.name = "TimeoutError"; return reject(e); }
    const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = lib(url, { method: o.method, headers: { "User-Agent": "Homebase-Monitor/1", Accept: "*/*" }, rejectUnauthorized: !o.insecure, signal: AbortSignal.timeout(left) } as any, res => {
      let certExpires: number | null = null;
      try { const c = (res.socket as any)?.getPeerCertificate?.(); if (c?.valid_to) certExpires = Date.parse(c.valid_to) || null; } catch { /* no certificate to read */ }
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      if (!o.wantBody) { res.destroy(); return resolve({ status: res.statusCode ?? 0, location, body: "", certExpires }); }
      const chunks: Buffer[] = []; let size = 0, done = false;
      const finish = () => { if (done) return; done = true; resolve({ status: res.statusCode ?? 0, location, body: Buffer.concat(chunks).toString("utf8"), certExpires }); };
      res.on("data", (c: Buffer) => { size += c.length; chunks.push(c); if (size > 512 * 1024) { res.destroy(); finish(); } });
      res.on("end", finish); res.on("close", finish);
      res.on("error", e => { if (!done) { done = true; reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

async function httpCheck(m: Pick<MonitorConfig, "target" | "method" | "kind" | "expect" | "keyword" | "invert" | "insecureTls" | "timeoutSeconds">): Promise<CheckResult> {
  const started = Date.now(), deadline = started + m.timeoutSeconds * 1000;
  const wantBody = m.kind === "keyword";
  let url = new URL(m.target), last: Once | null = null, cert: number | null = null;
  try {
    for (let hop = 0; hop < 6; hop++) {
      last = await httpOnce(url, { method: wantBody ? "GET" : m.method, insecure: m.insecureTls, deadline, wantBody });
      if (hop === 0 || url.protocol === "https:") cert = last.certExpires ?? cert;
      if (last.status >= 300 && last.status < 400 && last.location && !inRanges(last.status, m.expect)) {
        try { url = new URL(last.location, url); } catch { break; }
        if (url.protocol !== "http:" && url.protocol !== "https:") break;
        continue;
      }
      break;
    }
  } catch (e) { return { up: false, ms: null, message: explain(e, m.timeoutSeconds) }; }
  const ms = Date.now() - started;
  if (!last) return { up: false, ms: null, message: "No answer" };
  if (!inRanges(last.status, m.expect)) return { up: false, ms, message: `HTTP ${last.status} (expected ${m.expect})`, certExpires: cert };
  if (wantBody) {
    const found = last.body.toLowerCase().includes(m.keyword.toLowerCase());
    if (m.invert ? found : !found) return { up: false, ms, message: m.invert ? `The page contains "${m.keyword}"` : `The page does not contain "${m.keyword}"`, certExpires: cert };
  }
  return { up: true, ms, message: `HTTP ${last.status}`, certExpires: cert };
}

function tcpCheck(host: string, port: number, timeoutS: number): Promise<CheckResult> {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = netConnect({ host, port });
    const end = (r: CheckResult) => { socket.destroy(); resolve(r); };
    socket.setTimeout(timeoutS * 1000);
    socket.once("connect", () => end({ up: true, ms: Date.now() - started, message: `Port ${port} is open` }));
    socket.once("timeout", () => end({ up: false, ms: null, message: `Timed out after ${timeoutS} s` }));
    socket.once("error", e => end({ up: false, ms: null, message: explain(e, timeoutS) }));
  });
}

async function dnsCheck(m: Pick<MonitorConfig, "target" | "dnsType" | "dnsServer" | "keyword" | "timeoutSeconds">): Promise<CheckResult> {
  const started = Date.now();
  const resolver = new Resolver({ timeout: m.timeoutSeconds * 1000, tries: 1 });
  try {
    if (m.dnsServer) resolver.setServers([m.dnsServer]);
    const raw: any[] = await resolver.resolve(m.target, m.dnsType as any);
    const answers = raw.map(a => typeof a === "string" ? a : Array.isArray(a) ? a.join("") : a?.exchange ?? JSON.stringify(a));
    const ms = Date.now() - started;
    if (!answers.length) return { up: false, ms, message: "No answer" };
    if (m.keyword && !answers.some(a => a.toLowerCase().includes(m.keyword.toLowerCase()))) return { up: false, ms, message: `The answer does not contain "${m.keyword}" (got ${answers.slice(0, 3).join(", ")})` };
    return { up: true, ms, message: `${m.dnsType}: ${answers.slice(0, 3).join(", ")}${answers.length > 3 ? ", …" : ""}` };
  } catch (e) { return { up: false, ms: null, message: explain(e, m.timeoutSeconds) }; }
}

/** Runs one check, whatever its kind. Never throws. */
export async function runCheck(m: Omit<MonitorConfig, "id" | "position" | "enabled">): Promise<CheckResult> {
  try {
    if (m.kind === "tcp") return await tcpCheck(m.target, m.port, m.timeoutSeconds);
    if (m.kind === "dns") return await dnsCheck(m);
    return await httpCheck(m);
  } catch (e) { return { up: false, ms: null, message: explain(e, m.timeoutSeconds) }; }
}

// ---------------------------------------------------------------- state and history

const DAY = 86400_000, RAW_KEEP_DAYS = 8, DAILY_KEEP_DAYS = 400, MAX_MONITORS = 100, MAX_PARALLEL = 8, RETRY_MS = 20_000;

interface Live { state: MonitorState; since: number; fails: number; lastAt: number | null; lastMs: number | null; message: string; certWarned: number }
export interface MonitorView {
  id: string; name: string; kind: MonitorKind; enabled: boolean; state: MonitorState; since: number | null; lastAt: number | null; lastMs: number | null; message: string;
  uptime24h: number | null; uptime7d: number | null; uptime30d: number | null; avgMs24h: number | null; certExpires: number | null; strip: Array<0 | 1 | 2>;
  /** Only for signed-in administrators. */
  config?: MonitorConfig;
}

const pct = (up: number, down: number) => up + down === 0 ? null : Math.round((up / (up + down)) * 10000) / 100;

export class Monitors {
  private timers = new Map<string, NodeJS.Timeout>();
  private live = new Map<string, Live>();
  private waiting: Array<() => void> = [];
  private busy = 0;
  private pruneTimer?: NodeJS.Timeout;
  private stopped = false;
  private cache: { at: number; rows: MonitorView[] } | null = null;

  constructor(private db: DB) {}

  // ---- configuration

  list(): MonitorConfig[] {
    return (this.db.prepare(`SELECT ${COLS} FROM monitors ORDER BY position, created_at`).all() as unknown as Raw[]).map(toConfig);
  }
  get(id: string): MonitorConfig | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM monitors WHERE id = ?`).get(id) as Raw | undefined;
    return r ? toConfig(r) : undefined;
  }

  create(body: unknown): MonitorConfig {
    if (this.list().length >= MAX_MONITORS) throw new ValidationError(`Homebase keeps up to ${MAX_MONITORS} monitors`);
    const c = cleanMonitor(body);
    const id = "m" + randomUUID().replace(/-/g, "").slice(0, 10);
    const pos = Number((this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM monitors").get() as { p: number }).p);
    this.insert({ ...c, id, position: pos });
    this.reload(id, true);
    return this.get(id)!;
  }

  /** Used by the backup import, which brings its own ids. */
  insert(c: MonitorConfig): void {
    this.db.prepare(`INSERT INTO monitors (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(c.id, c.name, c.kind, c.target, c.port, c.keyword, c.invert ? 1 : 0, c.expect, c.method, c.dnsType, c.dnsServer, c.intervalSeconds, c.timeoutSeconds, c.retries, c.insecureTls ? 1 : 0, c.certWarnDays, c.enabled ? 1 : 0, c.position, Date.now());
  }

  update(id: string, body: unknown): MonitorConfig | undefined {
    const old = this.get(id); if (!old) return undefined;
    const c = cleanMonitor({ ...old, ...(body as object) }, old);
    this.db.prepare("UPDATE monitors SET name=?, kind=?, target=?, port=?, keyword=?, invert=?, expect=?, method=?, dns_type=?, dns_server=?, interval_s=?, timeout_s=?, retries=?, insecure_tls=?, cert_warn_days=?, enabled=?, cert_expires=NULL WHERE id=?")
      .run(c.name, c.kind, c.target, c.port, c.keyword, c.invert ? 1 : 0, c.expect, c.method, c.dnsType, c.dnsServer, c.intervalSeconds, c.timeoutSeconds, c.retries, c.insecureTls ? 1 : 0, c.certWarnDays, c.enabled ? 1 : 0, id);
    // A different target is a different thing to watch, so the old streak must not carry over.
    const changed = old.target !== c.target || old.port !== c.port || old.kind !== c.kind;
    this.reload(id, changed);
    return this.get(id);
  }

  remove(id: string): boolean {
    const gone = Number(this.db.prepare("DELETE FROM monitors WHERE id = ?").run(id).changes) === 1;
    if (!gone) return false;
    this.db.prepare("DELETE FROM monitor_checks WHERE monitor_id = ?").run(id);
    this.db.prepare("DELETE FROM monitor_daily WHERE monitor_id = ?").run(id);
    for (const p of this.db.prepare("SELECT id, monitors FROM status_pages").all() as unknown as Array<{ id: string; monitors: string }>) {
      const ids: string[] = JSON.parse(p.monitors);
      if (ids.includes(id)) this.db.prepare("UPDATE status_pages SET monitors = ? WHERE id = ?").run(JSON.stringify(ids.filter(x => x !== id)), p.id);
    }
    this.reload(id, true);
    return true;
  }

  clearAll(): void { this.db.exec("DELETE FROM monitors; DELETE FROM monitor_checks; DELETE FROM monitor_daily;"); for (const id of [...this.timers.keys()]) this.reload(id, true); this.live.clear(); this.cache = null; }

  // ---- scheduling

  start(): void {
    for (const m of this.list()) { this.restore(m.id); if (m.enabled) this.schedule(m.id, Math.random() * Math.min(m.intervalSeconds, 15) * 1000); }
    this.pruneTimer = setInterval(() => this.prune(), 3600_000); this.pruneTimer.unref();
    this.prune();
  }
  stop(): void { this.stopped = true; for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); if (this.pruneTimer) clearInterval(this.pruneTimer); }

  private reload(id: string, forget: boolean): void {
    const t = this.timers.get(id); if (t) clearTimeout(t); this.timers.delete(id);
    this.cache = null;
    const m = this.get(id);
    if (!m) { this.live.delete(id); return; }
    if (forget) this.live.delete(id);
    if (!this.live.has(id)) this.restore(id);
    if (m.enabled && !this.stopped && this.started()) this.schedule(id, 0);
  }
  private started(): boolean { return this.pruneTimer !== undefined; }

  private schedule(id: string, delayMs: number): void {
    if (this.stopped) return;
    const t = setTimeout(() => void this.tick(id), delayMs); t.unref(); this.timers.set(id, t);
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy >= MAX_PARALLEL) await new Promise<void>(r => this.waiting.push(r));
    this.busy++;
    try { return await fn(); } finally { this.busy--; this.waiting.shift()?.(); }
  }

  private async tick(id: string): Promise<void> {
    const m = this.get(id); if (!m || !m.enabled || this.stopped) return;
    await this.slot(() => this.checkNow(id));
    const m2 = this.get(id);
    if (!m2 || !m2.enabled || this.stopped) return;
    const pending = this.live.get(id)?.state === "pending";
    this.schedule(id, pending ? Math.min(RETRY_MS, m2.intervalSeconds * 1000) : m2.intervalSeconds * 1000);
  }

  /** Runs the check now, records it and returns what happened. */
  async checkNow(id: string): Promise<(CheckResult & { state: MonitorState }) | undefined> {
    const m = this.get(id); if (!m) return undefined;
    const r = await runCheck(m);
    if (!this.get(id)) return undefined; // removed while the check was running
    const state = this.record(m, r);
    return { ...r, state };
  }

  private record(m: MonitorConfig, r: CheckResult): MonitorState {
    const now = Date.now();
    const prev = this.live.get(m.id) ?? { state: "unknown" as MonitorState, since: now, fails: 0, lastAt: null, lastMs: null, message: "", certWarned: 0 };
    let next: MonitorState, s: 0 | 1 | 2;
    if (r.up) { next = "up"; s = 1; prev.fails = 0; }
    else { prev.fails++; if (prev.fails > m.retries) { next = "down"; s = 0; } else { next = "pending"; s = 2; } }
    // "pending" is a failed try that is still being repeated; "down" is shown only once the retries have run out.
    const shown: MonitorState = next;
    if (shown !== prev.state) {
      const was = prev.state, wasSince = prev.since;
      prev.state = shown; prev.since = now;
      if (shown === "down") logEvent(this.db, "error", "monitors", `${m.name} is down: ${r.message}`);
      else if (shown === "up" && was === "down") logEvent(this.db, "info", "monitors", `${m.name} is back up after ${duration(now - wasSince)}`);
    }
    prev.lastAt = now; prev.lastMs = r.ms; prev.message = r.message;
    this.live.set(m.id, prev);
    this.db.prepare("INSERT INTO monitor_checks (monitor_id, ts, s, ms, msg) VALUES (?, ?, ?, ?, ?)").run(m.id, now, s, r.ms, r.message.slice(0, 200));
    if (s !== 2) {
      this.db.prepare(`INSERT INTO monitor_daily (monitor_id, day, up, down, ms_sum, ms_n) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(monitor_id, day) DO UPDATE SET up = up + excluded.up, down = down + excluded.down, ms_sum = ms_sum + excluded.ms_sum, ms_n = ms_n + excluded.ms_n`)
        .run(m.id, Math.floor(now / DAY), s === 1 ? 1 : 0, s === 0 ? 1 : 0, s === 1 && r.ms !== null ? r.ms : 0, s === 1 && r.ms !== null ? 1 : 0);
    }
    if (r.certExpires !== undefined) {
      this.db.prepare("UPDATE monitors SET cert_expires = ? WHERE id = ?").run(r.certExpires, m.id);
      if (r.certExpires && m.certWarnDays > 0 && r.certExpires - now < m.certWarnDays * DAY && now - prev.certWarned > DAY) {
        prev.certWarned = now;
        const days = Math.floor((r.certExpires - now) / DAY);
        logEvent(this.db, "warn", "monitors", days < 0 ? `The certificate for ${m.name} has expired` : `The certificate for ${m.name} expires in ${days} day(s)`);
      }
    }
    this.cache = null;
    return shown;
  }

  /** After a restart, pick up where the last check left off so a monitor does not flash "unknown" or log a false recovery. */
  private restore(id: string): void {
    const last = this.db.prepare("SELECT ts, s, ms, msg FROM monitor_checks WHERE monitor_id = ? AND s IN (0, 1) ORDER BY ts DESC LIMIT 1").get(id) as { ts: number; s: number; ms: number | null; msg: string } | undefined;
    if (!last) { this.live.set(id, { state: "unknown", since: Date.now(), fails: 0, lastAt: null, lastMs: null, message: "", certWarned: 0 }); return; }
    const other = this.db.prepare("SELECT MAX(ts) AS t FROM monitor_checks WHERE monitor_id = ? AND s IN (0, 1) AND s <> ?").get(id, last.s) as { t: number | null };
    const since = (this.db.prepare("SELECT MIN(ts) AS t FROM monitor_checks WHERE monitor_id = ? AND s = ? AND ts > ?").get(id, last.s, other.t ?? 0) as { t: number | null }).t ?? last.ts;
    this.live.set(id, { state: last.s === 1 ? "up" : "down", since, fails: 0, lastAt: last.ts, lastMs: last.ms, message: last.msg, certWarned: 0 });
  }

  private prune(): void {
    const now = Date.now();
    this.db.prepare("DELETE FROM monitor_checks WHERE ts < ?").run(now - RAW_KEEP_DAYS * DAY);
    this.db.prepare("DELETE FROM monitor_daily WHERE day < ?").run(Math.floor(now / DAY) - DAILY_KEEP_DAYS);
  }

  // ---- reading

  view(admin: boolean): MonitorView[] {
    if (!this.cache || Date.now() - this.cache.at > 4000) {
      const now = Date.now(), today = Math.floor(now / DAY);
      const raw24 = this.db.prepare("SELECT SUM(s = 1) AS up, SUM(s = 0) AS down, AVG(CASE WHEN s = 1 THEN ms END) AS avg FROM monitor_checks WHERE monitor_id = ? AND ts > ? AND s IN (0, 1)");
      const daily = this.db.prepare("SELECT COALESCE(SUM(up), 0) AS up, COALESCE(SUM(down), 0) AS down FROM monitor_daily WHERE monitor_id = ? AND day > ?");
      const strip = this.db.prepare("SELECT s FROM monitor_checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT 40");
      const cert = this.db.prepare("SELECT cert_expires AS c FROM monitors WHERE id = ?");
      this.cache = {
        at: now, rows: this.list().map(m => {
          const live = this.live.get(m.id);
          const d = raw24.get(m.id, now - DAY) as { up: number | null; down: number | null; avg: number | null };
          const d7 = daily.get(m.id, today - 7) as { up: number; down: number }, d30 = daily.get(m.id, today - 30) as { up: number; down: number };
          return {
            id: m.id, name: m.name, kind: m.kind, enabled: m.enabled, state: !m.enabled ? "paused" : live?.state ?? "unknown", since: live?.since ?? null, lastAt: live?.lastAt ?? null,
            lastMs: live?.lastMs ?? null, message: live?.message ?? "", uptime24h: pct(d.up ?? 0, d.down ?? 0), uptime7d: pct(d7.up, d7.down), uptime30d: pct(d30.up, d30.down),
            avgMs24h: d.avg === null ? null : Math.round(d.avg), certExpires: (cert.get(m.id) as { c: number | null }).c,
            strip: (strip.all(m.id) as unknown as Array<{ s: 0 | 1 | 2 }>).map(x => x.s).reverse(), config: m
          };
        })
      };
    }
    return this.cache.rows.map(r => admin ? r : { ...r, config: undefined });
  }

  /** Response times over the last `hours`, grouped so a chart gets at most about 120 points. */
  history(id: string, hours: number): Array<{ t: number; ms: number | null; down: boolean }> {
    const span = Math.max(1, Math.min(RAW_KEEP_DAYS * 24, hours)) * 3600_000, now = Date.now();
    const bucket = Math.max(60_000, Math.ceil(span / 120 / 60_000) * 60_000);
    const rows = this.db.prepare("SELECT (ts / ?) * ? AS t, AVG(CASE WHEN s = 1 THEN ms END) AS ms, SUM(s = 0) AS down FROM monitor_checks WHERE monitor_id = ? AND ts > ? AND s IN (0, 1) GROUP BY t ORDER BY t")
      .all(bucket, bucket, id, now - span) as unknown as Array<{ t: number; ms: number | null; down: number }>;
    return rows.map(r => ({ t: r.t, ms: r.ms === null ? null : Math.round(r.ms), down: r.down > 0 }));
  }

  /** One entry per day for the last `n` days (oldest first), for the uptime bars. */
  days(id: string, n: number): Array<{ day: number; up: number; down: number }> {
    const today = Math.floor(Date.now() / DAY);
    const rows = new Map((this.db.prepare("SELECT day, up, down FROM monitor_daily WHERE monitor_id = ? AND day > ?").all(id, today - n) as unknown as Array<{ day: number; up: number; down: number }>).map(r => [r.day, r]));
    return Array.from({ length: n }, (_, i) => { const day = today - n + 1 + i, r = rows.get(day); return { day, up: r?.up ?? 0, down: r?.down ?? 0 }; });
  }

  recent(id: string, limit = 50): Array<{ ts: number; s: number; ms: number | null; msg: string }> {
    return this.db.prepare("SELECT ts, s, ms, msg FROM monitor_checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT ?").all(id, Math.max(1, Math.min(200, limit))) as unknown as Array<{ ts: number; s: number; ms: number | null; msg: string }>;
  }
}

const duration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
};

// ---------------------------------------------------------------- public status pages

export interface StatusPageRow { id: string; title: string; message: string; monitors: string[]; enabled: boolean; createdAt: number; lastUsed: number | null; views: number }
interface PageRaw { id: string; title: string; message: string; monitors: string; token_hash: string; token_sealed: string; enabled: number; created_at: number; last_used: number | null; views: number }
const PCOLS = "id, title, message, monitors, token_hash, token_sealed, enabled, created_at, last_used, views";
const mapPage = (r: PageRaw): StatusPageRow => ({ id: r.id, title: r.title, message: r.message, monitors: JSON.parse(r.monitors), enabled: Boolean(r.enabled), createdAt: r.created_at, lastUsed: r.last_used, views: r.views });

export class StatusPages {
  constructor(private db: DB, private box: SecretBox, private monitors: Monitors) {}

  list(): Array<StatusPageRow & { token: string }> {
    return (this.db.prepare(`SELECT ${PCOLS} FROM status_pages ORDER BY created_at DESC`).all() as unknown as PageRaw[]).map(r => ({ ...mapPage(r), token: this.box.open(r.token_sealed) }));
  }

  private clean(body: any, keep?: StatusPageRow) {
    const title = String(body?.title ?? keep?.title ?? "").trim();
    if (!title || title.length > 80) throw new ValidationError("Give the page a title (up to 80 characters)");
    const message = String(body?.message ?? keep?.message ?? "").trim().slice(0, 400);
    const have = new Set(this.monitors.list().map(m => m.id));
    const ids = [...new Set<string>((Array.isArray(body?.monitors) ? body.monitors : keep?.monitors ?? []).map(String))].filter(id => have.has(id));
    if (!ids.length) throw new ValidationError("Choose at least one monitor to show");
    return { title, message, ids, enabled: body?.enabled === undefined ? (keep?.enabled ?? true) : Boolean(body.enabled) };
  }

  create(body: unknown) {
    const c = this.clean(body);
    const token = randomBytes(24).toString("base64url"), id = "p" + randomUUID().replace(/-/g, "").slice(0, 10);
    this.db.prepare(`INSERT INTO status_pages (${PCOLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`).run(id, c.title, c.message, JSON.stringify(c.ids), hashToken(token), this.box.seal(token), c.enabled ? 1 : 0, Date.now());
    return this.list().find(p => p.id === id)!;
  }
  update(id: string, body: unknown) {
    const old = this.list().find(p => p.id === id); if (!old) return undefined;
    const c = this.clean(body, old);
    this.db.prepare("UPDATE status_pages SET title = ?, message = ?, monitors = ?, enabled = ? WHERE id = ?").run(c.title, c.message, JSON.stringify(c.ids), c.enabled ? 1 : 0, id);
    return this.list().find(p => p.id === id);
  }
  /** A new address for the same page; the old one stops working. */
  rotate(id: string) {
    const token = randomBytes(24).toString("base64url");
    if (Number(this.db.prepare("UPDATE status_pages SET token_hash = ?, token_sealed = ? WHERE id = ?").run(hashToken(token), this.box.seal(token), id).changes) !== 1) return undefined;
    return this.list().find(p => p.id === id);
  }
  remove(id: string): boolean { return Number(this.db.prepare("DELETE FROM status_pages WHERE id = ?").run(id).changes) === 1; }

  /** What the public page shows. Names, state and uptime only: never an address, a key or an error text. */
  publicView(token: string) {
    if (typeof token !== "string" || token.length < 20 || token.length > 80) return undefined;
    const r = this.db.prepare(`SELECT ${PCOLS} FROM status_pages WHERE token_hash = ?`).get(hashToken(token)) as PageRaw | undefined;
    if (!r || !r.enabled) return undefined;
    const page = mapPage(r);
    this.db.prepare("UPDATE status_pages SET views = views + 1, last_used = ? WHERE id = ?").run(Date.now(), page.id);
    const byId = new Map(this.monitors.view(false).map(m => [m.id, m]));
    const rows = page.monitors.map(id => byId.get(id)).filter((m): m is MonitorView => Boolean(m));
    const monitors = rows.map(m => ({ name: m.name, state: m.state, uptime24h: m.uptime24h, uptime30d: m.uptime30d, ms: m.lastMs, days: this.monitors.days(m.id, 45) }));
    const live = rows.filter(m => m.state !== "paused" && m.state !== "unknown");
    const down = live.filter(m => m.state === "down").length;
    const overall = !live.length ? "unknown" : down === 0 ? "up" : down === live.length ? "down" : "degraded";
    return { title: page.title, message: page.message, overall, updatedAt: Date.now(), monitors };
  }
}

// ---------------------------------------------------------------- backup file support

export function exportMonitors(db: DB) {
  const monitors = (db.prepare(`SELECT ${COLS} FROM monitors ORDER BY position, created_at`).all() as unknown as Raw[]).map(toConfig);
  const statusPages = (db.prepare(`SELECT ${PCOLS} FROM status_pages ORDER BY created_at`).all() as unknown as PageRaw[]).map(mapPage);
  return { monitors, statusPages: statusPages.map(({ id, title, message, monitors: m, enabled }) => ({ id, title, message, monitors: m, enabled })) };
}
