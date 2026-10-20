import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Resolver } from "node:dns/promises";
import { hashToken } from "./auth.js";
import type { SecretBox } from "./crypto.js";
import { ValidationError } from "./dashboard.js";
import { logEvent, type DB } from "./db.js";
import { getSettings } from "./settings.js";

// ================================================================ shapes

export type MonitorKind = "http" | "keyword" | "json" | "tcp" | "ping" | "dns" | "cert" | "push";
export const MONITOR_KINDS: readonly MonitorKind[] = ["http", "keyword", "json", "tcp", "ping", "dns", "cert", "push"];
const WEB: readonly MonitorKind[] = ["http", "keyword", "json"];
export type MonitorState = "up" | "down" | "pending" | "paused" | "maintenance" | "unknown";
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export interface MonitorConfig {
  id: string; name: string; group: string; description: string; kind: MonitorKind; target: string; port: number;
  keyword: string; invert: boolean; jsonPath: string; expect: string; method: string; body: string; headers: string; authUser: string; hasAuthPass: boolean;
  maxRedirects: number; upsideDown: boolean; dnsType: string; dnsServer: string;
  intervalSeconds: number; retryIntervalSeconds: number; timeoutSeconds: number; retries: number; insecureTls: boolean; certWarnDays: number; enabled: boolean; position: number;
}
/** What a check needs to run: the saved settings plus the password, which is never sent to a browser. */
export type Spec = MonitorConfig & { authPass: string };

interface Raw {
  id: string; name: string; group_name: string; description: string; kind: string; target: string; port: number; keyword: string; invert: number; json_path: string; expect: string;
  method: string; body: string; auth_user: string; secret: string; max_redirects: number; upside_down: number; dns_type: string; dns_server: string;
  interval_s: number; retry_s: number; timeout_s: number; retries: number; insecure_tls: number; cert_warn_days: number; enabled: number; position: number; cert_expires: number | null; created_at: number;
}
const COLS = "id, name, group_name, description, kind, target, port, keyword, invert, json_path, expect, method, body, auth_user, secret, max_redirects, upside_down, dns_type, dns_server, interval_s, retry_s, timeout_s, retries, insecure_tls, cert_warn_days, enabled, position, cert_expires, created_at";

export interface CheckResult { up: boolean; ms: number | null; message: string; certExpires?: number | null }

// ================================================================ validation

const HOST = /^[A-Za-z0-9._:-]{1,253}$/, RANGES = /^\d{3}(-\d{3})?(,\d{3}(-\d{3})?)*$/, DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const int = (v: unknown, lo: number, hi: number, dflt: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== "" && v !== null && v !== undefined ? Math.max(lo, Math.min(hi, n)) : dflt; };

function cleanHeaders(text: string): string {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 20) throw new ValidationError("Up to 20 request headers");
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i < 1 || !HEADER_NAME.test(l.slice(0, i).trim())) throw new ValidationError(`A header must look like "Name: value" (problem: ${l.slice(0, 40)})`);
  }
  return lines.join("\n");
}

/** Turns what the form sent into a checked monitor, or says in plain words what is wrong. `authPass` is undefined when the form left it blank. */
export function cleanMonitor(body: any, keep?: MonitorConfig): Omit<Spec, "id" | "position" | "hasAuthPass" | "authPass"> & { authPass: string | undefined } {
  const b = body ?? {};
  const kind = String(b.kind ?? keep?.kind ?? "http") as MonitorKind;
  if (!MONITOR_KINDS.includes(kind)) throw new ValidationError("Choose what to check");
  const web = WEB.includes(kind);
  let target = String(b.target ?? "").trim(), port = 0;
  if (web) {
    let u: URL;
    try { u = new URL(target); } catch { throw new ValidationError("Enter a full address such as https://example.com"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new ValidationError("The address must start with http:// or https://");
    if (target.length > 500) throw new ValidationError("That address is too long");
  } else if (kind === "push") {
    // The address a script calls. It is made here and never typed in.
    target = keep?.kind === "push" ? keep.target : randomBytes(24).toString("base64url");
  } else {
    if (!HOST.test(target) || target.startsWith("-")) throw new ValidationError("Enter a host name or an IP address, for example 192.168.1.10 or nas.local");
    if (kind === "tcp" || kind === "cert") {
      const given = Math.round(Number(b.port));
      port = kind === "cert" && !given ? 443 : given;
      if (!(port >= 1 && port <= 65535)) throw new ValidationError("Enter a port between 1 and 65535");
    }
  }
  const keyword = String(b.keyword ?? "").trim().slice(0, 200);
  if (kind === "keyword" && !keyword) throw new ValidationError("Enter the word or phrase that must (or must not) appear on the page");
  const jsonPath = kind === "json" ? String(b.jsonPath ?? "").trim().slice(0, 200) : "";
  if (kind === "json" && !jsonPath) throw new ValidationError("Enter the field to read from the answer, for example status or data.items[0].state");
  const expect = String(b.expect ?? "200-299").replace(/\s+/g, "") || "200-299";
  if (!RANGES.test(expect)) throw new ValidationError("Allowed status codes look like 200-299 or 200,301,404");
  const dnsType = String(b.dnsType ?? "A").toUpperCase();
  if (kind === "dns" && !DNS_TYPES.includes(dnsType)) throw new ValidationError("Choose a DNS record type");
  const dnsServer = String(b.dnsServer ?? "").trim();
  if (dnsServer && !/^[0-9a-fA-F:.]{3,45}$/.test(dnsServer)) throw new ValidationError("A DNS server is given as an IP address, for example 192.168.1.1");
  const group = String(b.group ?? "").trim().slice(0, 40), description = String(b.description ?? "").trim().slice(0, 200);
  const name = String(b.name ?? "").trim() || (web ? new URL(target).host : kind === "push" ? "Heartbeat" : kind === "tcp" || kind === "cert" ? `${target}:${port}` : target);
  if (name.length > 60) throw new ValidationError("The name is too long (60 characters at most)");
  const intervalSeconds = int(b.intervalSeconds, 20, 86400, keep?.intervalSeconds ?? 60);
  const method = METHODS.includes(String(b.method).toUpperCase() as never) ? String(b.method).toUpperCase() : "GET";
  const headers = web ? cleanHeaders(String(b.headers ?? "")) : "";
  if (headers.length > 2000) throw new ValidationError("The request headers are too long");
  const reqBody = web ? String(b.body ?? "").slice(0, 4000) : "";
  const authUser = web ? String(b.authUser ?? "").trim().slice(0, 100) : "";
  const authPass = !authUser ? "" : typeof b.authPass === "string" && b.authPass !== "" ? b.authPass.slice(0, 200) : undefined;
  return {
    name, group, description, kind, target, port, keyword: kind === "keyword" || kind === "dns" || kind === "json" ? keyword : "", invert: kind === "keyword" && Boolean(b.invert), jsonPath, expect,
    method: kind === "http" ? method : kind === "keyword" || kind === "json" ? (method === "HEAD" ? "GET" : method) : "GET", body: reqBody, headers, authUser, authPass,
    maxRedirects: int(b.maxRedirects, 0, 10, keep?.maxRedirects ?? 5), upsideDown: Boolean(b.upsideDown),
    dnsType: kind === "dns" ? dnsType : "A", dnsServer: kind === "dns" ? dnsServer : "",
    intervalSeconds, retryIntervalSeconds: int(b.retryIntervalSeconds, 20, 86400, keep?.retryIntervalSeconds ?? 20), timeoutSeconds: Math.min(int(b.timeoutSeconds, 1, 60, keep?.timeoutSeconds ?? 10), intervalSeconds),
    retries: int(b.retries, 0, 10, keep?.retries ?? 1), insecureTls: web && Boolean(b.insecureTls), certWarnDays: int(b.certWarnDays, 0, 365, keep?.certWarnDays ?? 14),
    enabled: b.enabled === undefined ? (keep?.enabled ?? true) : Boolean(b.enabled)
  };
}

// ================================================================ the checks themselves

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
interface Req { method: string; insecure: boolean; deadline: number; wantBody: boolean; headers: Record<string, string>; body?: string }
function httpOnce(url: URL, o: Req): Promise<Once> {
  return new Promise((resolve, reject) => {
    const left = o.deadline - Date.now();
    if (left <= 0) { const e = new Error("timed out"); e.name = "TimeoutError"; return reject(e); }
    const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = { "User-Agent": "Homebase-Monitor/1", Accept: "*/*", ...o.headers };
    if (o.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(o.body));
    const req = lib(url, { method: o.method, headers, rejectUnauthorized: !o.insecure, signal: AbortSignal.timeout(left) } as any, res => {
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
    req.end(o.body);
  });
}

const parseHeaders = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const l of text.split("\n")) { const i = l.indexOf(":"); if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return out;
};

/** Reads `a.b[0].c` out of a parsed JSON value. */
export function readPath(data: unknown, path: string): unknown {
  let cur: any = data;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

async function httpCheck(m: Spec): Promise<CheckResult> {
  const started = Date.now(), deadline = started + m.timeoutSeconds * 1000;
  const wantBody = m.kind === "keyword" || m.kind === "json";
  const headers = parseHeaders(m.headers);
  if (m.authUser) headers.Authorization = `Basic ${Buffer.from(`${m.authUser}:${m.authPass}`).toString("base64")}`;
  const sends = m.body && !["GET", "HEAD", "OPTIONS"].includes(m.method);
  if (sends && !Object.keys(headers).some(h => h.toLowerCase() === "content-type")) headers["Content-Type"] = /^\s*[{[]/.test(m.body) ? "application/json" : "text/plain";
  let url = new URL(m.target), method = m.method, body = sends ? m.body : undefined, last: Once | null = null, cert: number | null = null;
  try {
    for (let hop = 0; hop <= m.maxRedirects; hop++) {
      last = await httpOnce(url, { method: wantBody && method === "HEAD" ? "GET" : method, insecure: m.insecureTls, deadline, wantBody, headers, body });
      if (hop === 0 || url.protocol === "https:") cert = last.certExpires ?? cert;
      if (last.status >= 300 && last.status < 400 && last.location && !inRanges(last.status, m.expect) && hop < m.maxRedirects) {
        try { url = new URL(last.location, url); } catch { break; }
        if (url.protocol !== "http:" && url.protocol !== "https:") break;
        if ([301, 302, 303].includes(last.status) && method !== "HEAD") { method = "GET"; body = undefined; }
        continue;
      }
      break;
    }
  } catch (e) { return { up: false, ms: null, message: explain(e, m.timeoutSeconds) }; }
  const ms = Date.now() - started;
  if (!last) return { up: false, ms: null, message: "No answer" };
  if (!inRanges(last.status, m.expect)) return { up: false, ms, message: `HTTP ${last.status} (expected ${m.expect})`, certExpires: cert };
  if (m.kind === "keyword") {
    const found = last.body.toLowerCase().includes(m.keyword.toLowerCase());
    if (m.invert ? found : !found) return { up: false, ms, message: m.invert ? `The page contains "${m.keyword}"` : `The page does not contain "${m.keyword}"`, certExpires: cert };
  }
  if (m.kind === "json") {
    let data: unknown;
    try { data = JSON.parse(last.body); } catch { return { up: false, ms, message: "The answer is not JSON", certExpires: cert }; }
    const v = readPath(data, m.jsonPath);
    if (v === undefined) return { up: false, ms, message: `"${m.jsonPath}" is not in the answer`, certExpires: cert };
    const text = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    if (m.keyword !== "" && text !== m.keyword) return { up: false, ms, message: `${m.jsonPath} is "${text.slice(0, 60)}", expected "${m.keyword}"`, certExpires: cert };
    return { up: true, ms, message: `${m.jsonPath} = ${text.slice(0, 60)}`, certExpires: cert };
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

function pingCheck(host: string, timeoutS: number): Promise<CheckResult> {
  return new Promise(resolve => {
    execFile("ping", ["-c", "1", "-W", String(timeoutS), host], { timeout: (timeoutS + 2) * 1000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      const t = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
      if (!err && t) return resolve({ up: true, ms: Math.round(Number(t[1])), message: `Replied in ${Math.round(Number(t[1]))} ms` });
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return resolve({ up: false, ms: null, message: "ping is not installed on this machine" });
      if (/permission denied|operation not permitted|socket/i.test(out)) return resolve({ up: false, ms: null, message: "This container may not send pings (it needs the NET_RAW permission)" });
      if (/unknown host|bad address|name or service not known|not known/i.test(out)) return resolve({ up: false, ms: null, message: "Name not found" });
      resolve({ up: false, ms: null, message: err ? `No reply within ${timeoutS} s` : "No reply" });
    });
  });
}

function certCheck(host: string, port: number, warnDays: number, timeoutS: number): Promise<CheckResult> {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = tlsConnect({ host, port, servername: /^[\d.:]+$/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutS * 1000 });
    const end = (r: CheckResult) => { socket.destroy(); resolve(r); };
    socket.once("secureConnect", () => {
      const c = socket.getPeerCertificate();
      const ends = c?.valid_to ? Date.parse(c.valid_to) : NaN;
      if (!Number.isFinite(ends)) return end({ up: false, ms: null, message: "The server sent no certificate" });
      const days = Math.floor((ends - Date.now()) / DAY);
      const when = new Date(ends).toISOString().slice(0, 10);
      if (days < 0) return end({ up: false, ms: Date.now() - started, message: `The certificate ended on ${when}`, certExpires: ends });
      if (warnDays > 0 && days < warnDays) return end({ up: false, ms: Date.now() - started, message: `The certificate ends in ${days} day(s), on ${when}`, certExpires: ends });
      end({ up: true, ms: Date.now() - started, message: `Valid for ${days} more day(s), until ${when}`, certExpires: ends });
    });
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

/** Runs one active check, whatever its kind. Never throws. (A push monitor has nothing to run: scripts call in.) */
export async function runCheck(m: Spec): Promise<CheckResult> {
  try {
    let r: CheckResult;
    if (m.kind === "tcp") r = await tcpCheck(m.target, m.port, m.timeoutSeconds);
    else if (m.kind === "ping") r = await pingCheck(m.target, m.timeoutSeconds);
    else if (m.kind === "cert") r = await certCheck(m.target, m.port, m.certWarnDays, m.timeoutSeconds);
    else if (m.kind === "dns") r = await dnsCheck(m);
    else if (m.kind === "push") r = { up: true, ms: null, message: "Waiting for a heartbeat" };
    else r = await httpCheck(m);
    // "Upside down" counts a reachable target as a failure, for things that must NOT answer.
    return m.upsideDown ? { ...r, up: !r.up, message: `${r.up ? "Answered, but should not" : "No answer, as wanted"} (${r.message})` } : r;
  } catch (e) { return { up: false, ms: null, message: explain(e, m.timeoutSeconds) }; }
}

// ================================================================ maintenance windows

export interface WindowConfig {
  id: string; title: string; monitors: string[]; kind: "once" | "daily" | "weekly"; startsAt: number | null; endsAt: number | null; days: number[]; startTime: string; durationMin: number; enabled: boolean;
}
interface WinRaw { id: string; title: string; monitors: string; kind: string; starts_at: number | null; ends_at: number | null; days: string; start_time: string; duration_min: number; enabled: number }
const WCOLS = "id, title, monitors, kind, starts_at, ends_at, days, start_time, duration_min, enabled";
const mapWin = (r: WinRaw): WindowConfig => ({ id: r.id, title: r.title, monitors: JSON.parse(r.monitors), kind: r.kind === "daily" ? "daily" : r.kind === "weekly" ? "weekly" : "once", startsAt: r.starts_at, endsAt: r.ends_at, days: r.days ? r.days.split(",").map(Number) : [], startTime: r.start_time, durationMin: r.duration_min, enabled: Boolean(r.enabled) });
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The weekday (0 = Sunday) and minutes since midnight at `ms` in a time zone. */
function localParts(ms: number, tz: string): { dow: number; min: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
    return { dow: Math.max(0, DOW.indexOf(get("weekday"))), min: Number(get("hour")) * 60 + Number(get("minute")) };
  } catch { const d = new Date(ms); return { dow: d.getDay(), min: d.getHours() * 60 + d.getMinutes() }; }
}

export class Windows {
  constructor(private db: DB, private monitorIds: () => string[]) {}

  list(): WindowConfig[] { return (this.db.prepare(`SELECT ${WCOLS} FROM maintenance_windows ORDER BY created_at DESC`).all() as unknown as WinRaw[]).map(mapWin); }

  private clean(body: any, keep?: WindowConfig) {
    const title = String(body?.title ?? keep?.title ?? "").trim();
    if (!title || title.length > 80) throw new ValidationError("Give the window a title (up to 80 characters)");
    const kind = String(body?.kind ?? keep?.kind ?? "once");
    if (!["once", "daily", "weekly"].includes(kind)) throw new ValidationError("Choose when the window happens");
    const have = new Set(this.monitorIds());
    const monitors = [...new Set<string>((Array.isArray(body?.monitors) ? body.monitors : keep?.monitors ?? []).map(String))].filter(id => have.has(id));
    let startsAt: number | null = null, endsAt: number | null = null, days: number[] = [], startTime = "00:00", durationMin = 60;
    if (kind === "once") {
      startsAt = Number(body?.startsAt ?? keep?.startsAt); endsAt = Number(body?.endsAt ?? keep?.endsAt);
      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) throw new ValidationError("Choose a start and an end, with the end after the start");
    } else {
      startTime = String(body?.startTime ?? keep?.startTime ?? "");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new ValidationError("Enter the start time like 02:30");
      durationMin = int(body?.durationMin ?? keep?.durationMin, 1, 1440, 60);
      if (kind === "weekly") {
        days = [...new Set<number>((Array.isArray(body?.days) ? body.days : keep?.days ?? []).map(Number))].filter(d => d >= 0 && d <= 6).sort();
        if (!days.length) throw new ValidationError("Choose at least one day of the week");
      }
    }
    return { title, kind, monitors, startsAt, endsAt, days, startTime, durationMin, enabled: body?.enabled === undefined ? (keep?.enabled ?? true) : Boolean(body.enabled) };
  }
  create(body: unknown): WindowConfig {
    const c = this.clean(body), id = "w" + randomUUID().replace(/-/g, "").slice(0, 10);
    this.db.prepare(`INSERT INTO maintenance_windows (${WCOLS}, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, c.title, JSON.stringify(c.monitors), c.kind, c.startsAt, c.endsAt, c.days.join(","), c.startTime, c.durationMin, c.enabled ? 1 : 0, Date.now());
    return this.list().find(w => w.id === id)!;
  }
  update(id: string, body: unknown): WindowConfig | undefined {
    const old = this.list().find(w => w.id === id); if (!old) return undefined;
    const c = this.clean(body, old);
    this.db.prepare("UPDATE maintenance_windows SET title=?, monitors=?, kind=?, starts_at=?, ends_at=?, days=?, start_time=?, duration_min=?, enabled=? WHERE id=?")
      .run(c.title, JSON.stringify(c.monitors), c.kind, c.startsAt, c.endsAt, c.days.join(","), c.startTime, c.durationMin, c.enabled ? 1 : 0, id);
    return this.list().find(w => w.id === id);
  }
  remove(id: string): boolean { return Number(this.db.prepare("DELETE FROM maintenance_windows WHERE id = ?").run(id).changes) === 1; }
  forgetMonitor(monitorId: string): void {
    for (const w of this.list()) if (w.monitors.includes(monitorId)) this.db.prepare("UPDATE maintenance_windows SET monitors = ? WHERE id = ?").run(JSON.stringify(w.monitors.filter(x => x !== monitorId)), w.id);
  }

  /** Is this monitor inside a maintenance window right now? An empty monitor list means every monitor. */
  active(monitorId: string, now = Date.now(), tz = "UTC", windows = this.list()): WindowConfig | undefined {
    const { dow, min } = localParts(now, tz);
    return windows.find(w => {
      if (!w.enabled || (w.monitors.length && !w.monitors.includes(monitorId))) return false;
      if (w.kind === "once") return w.startsAt !== null && w.endsAt !== null && now >= w.startsAt && now < w.endsAt;
      const [h, m] = w.startTime.split(":").map(Number), start = h * 60 + m, end = start + w.durationMin;
      const todayOk = w.kind === "daily" || w.days.includes(dow), yesterdayOk = w.kind === "daily" || w.days.includes((dow + 6) % 7);
      return (todayOk && min >= start && min < end) || (yesterdayOk && end > 1440 && min < end - 1440);
    });
  }
}

// ================================================================ state and history

const DAY = 86400_000, RAW_KEEP_DAYS = 8, DAILY_KEEP_DAYS = 400, MAX_MONITORS = 200, MAX_PARALLEL = 8;

interface Live { state: MonitorState; since: number; fails: number; lastAt: number | null; lastMs: number | null; message: string; certWarned: number }
export interface MonitorView {
  id: string; name: string; group: string; description: string; kind: MonitorKind; enabled: boolean; state: MonitorState; since: number | null; lastAt: number | null; lastMs: number | null; message: string;
  uptime24h: number | null; uptime7d: number | null; uptime30d: number | null; avgMs24h: number | null; certExpires: number | null; strip: Array<0 | 1 | 2 | 3>;
  /** Only for signed-in administrators. */
  config?: MonitorConfig;
}

const pct = (up: number, down: number) => up + down === 0 ? null : Math.round((up / (up + down)) * 10000) / 100;

export class Monitors {
  private timers = new Map<string, NodeJS.Timeout>();
  private live = new Map<string, Live>();
  private beats = new Map<string, number>();
  private lastTick = new Map<string, number>();
  private waiting: Array<() => void> = [];
  private busy = 0;
  private pruneTimer?: NodeJS.Timeout;
  private stopped = false;
  private cache: { at: number; rows: MonitorView[] } | null = null;
  readonly windows: Windows;

  constructor(private db: DB, private box: SecretBox) { this.windows = new Windows(db, () => this.list().map(m => m.id)); }

  // ---- configuration

  private map(r: Raw): MonitorConfig {
    let headers = "", hasAuthPass = false;
    if (r.secret) { try { const s = JSON.parse(this.box.open(r.secret)); headers = String(s.headers ?? ""); hasAuthPass = Boolean(s.authPass); } catch { /* unreadable: treated as empty */ } }
    return {
      id: r.id, name: r.name, group: r.group_name, description: r.description, kind: (MONITOR_KINDS as readonly string[]).includes(r.kind) ? r.kind as MonitorKind : "http", target: r.target, port: r.port,
      keyword: r.keyword, invert: Boolean(r.invert), jsonPath: r.json_path, expect: r.expect, method: r.method, body: r.body, headers, authUser: r.auth_user, hasAuthPass,
      maxRedirects: r.max_redirects, upsideDown: Boolean(r.upside_down), dnsType: r.dns_type, dnsServer: r.dns_server, intervalSeconds: r.interval_s, retryIntervalSeconds: r.retry_s,
      timeoutSeconds: r.timeout_s, retries: r.retries, insecureTls: Boolean(r.insecure_tls), certWarnDays: r.cert_warn_days, enabled: Boolean(r.enabled), position: r.position
    };
  }
  private rows(): Raw[] { return this.db.prepare(`SELECT ${COLS} FROM monitors ORDER BY position, created_at`).all() as unknown as Raw[]; }

  list(): MonitorConfig[] { return this.rows().map(r => this.map(r)); }
  get(id: string): MonitorConfig | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM monitors WHERE id = ?`).get(id) as Raw | undefined;
    return r ? this.map(r) : undefined;
  }
  private spec(id: string): Spec | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM monitors WHERE id = ?`).get(id) as Raw | undefined;
    if (!r) return undefined;
    let authPass = "";
    if (r.secret) { try { authPass = String(JSON.parse(this.box.open(r.secret)).authPass ?? ""); } catch { /* none */ } }
    return { ...this.map(r), authPass };
  }

  /** A monitor as typed in the form, for trying it out. A blank password falls back to the saved one of `body.id`. */
  forTest(body: any): Spec {
    const c = cleanMonitor(body);
    const saved = typeof body?.id === "string" ? this.spec(body.id)?.authPass : undefined;
    return { ...c, id: "", position: 0, hasAuthPass: false, authPass: c.authPass ?? saved ?? "" };
  }

  private sealed(headers: string, authPass: string): string { return headers || authPass ? this.box.seal(JSON.stringify({ headers, authPass })) : ""; }

  create(body: unknown): MonitorConfig {
    if (this.rows().length >= MAX_MONITORS) throw new ValidationError(`Homebase keeps up to ${MAX_MONITORS} monitors`);
    const c = cleanMonitor(body);
    const id = "m" + randomUUID().replace(/-/g, "").slice(0, 10);
    const pos = Number((this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM monitors").get() as { p: number }).p);
    this.insert({ ...c, id, position: pos, authPass: c.authPass ?? "", hasAuthPass: false });
    this.reload(id, true);
    return this.get(id)!;
  }

  /** Used by creation and by the backup import (which brings its own ids). */
  insert(c: Spec): void {
    this.db.prepare(`INSERT INTO monitors (${COLS}) VALUES (${COLS.split(",").map(() => "?").join(", ")})`).run(
      c.id, c.name, c.group, c.description, c.kind, c.target, c.port, c.keyword, c.invert ? 1 : 0, c.jsonPath, c.expect, c.method, c.body, c.authUser, this.sealed(c.headers, c.authPass),
      c.maxRedirects, c.upsideDown ? 1 : 0, c.dnsType, c.dnsServer, c.intervalSeconds, c.retryIntervalSeconds, c.timeoutSeconds, c.retries, c.insecureTls ? 1 : 0, c.certWarnDays, c.enabled ? 1 : 0, c.position, null, Date.now());
  }

  update(id: string, body: unknown): MonitorConfig | undefined {
    const old = this.spec(id); if (!old) return undefined;
    const c = cleanMonitor({ ...old, ...(body as object), authPass: (body as any)?.authPass }, old);
    // A blank password keeps the saved one, unless the user name was cleared or changed to nothing.
    const authPass = c.authUser ? (c.authPass ?? old.authPass) : "";
    this.db.prepare("UPDATE monitors SET name=?, group_name=?, description=?, kind=?, target=?, port=?, keyword=?, invert=?, json_path=?, expect=?, method=?, body=?, auth_user=?, secret=?, max_redirects=?, upside_down=?, dns_type=?, dns_server=?, interval_s=?, retry_s=?, timeout_s=?, retries=?, insecure_tls=?, cert_warn_days=?, enabled=?, cert_expires=NULL WHERE id=?")
      .run(c.name, c.group, c.description, c.kind, c.target, c.port, c.keyword, c.invert ? 1 : 0, c.jsonPath, c.expect, c.method, c.body, c.authUser, this.sealed(c.headers, authPass), c.maxRedirects, c.upsideDown ? 1 : 0, c.dnsType, c.dnsServer, c.intervalSeconds, c.retryIntervalSeconds, c.timeoutSeconds, c.retries, c.insecureTls ? 1 : 0, c.certWarnDays, c.enabled ? 1 : 0, id);
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
    this.windows.forgetMonitor(id);
    this.reload(id, true);
    return true;
  }

  clearAll(): void {
    this.db.exec("DELETE FROM monitors; DELETE FROM monitor_checks; DELETE FROM monitor_daily; DELETE FROM maintenance_windows;");
    for (const id of [...this.timers.keys()]) this.reload(id, true);
    this.live.clear(); this.cache = null;
  }

  // ---- scheduling

  start(): void {
    for (const m of this.list()) { this.restore(m.id); this.beats.set(m.id, Date.now()); if (m.enabled) this.schedule(m.id, Math.random() * Math.min(m.intervalSeconds, 15) * 1000); }
    this.pruneTimer = setInterval(() => this.prune(), 3600_000); this.pruneTimer.unref();
    this.prune();
  }
  stop(): void { this.stopped = true; for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); if (this.pruneTimer) clearInterval(this.pruneTimer); }

  private reload(id: string, forget: boolean): void {
    const t = this.timers.get(id); if (t) clearTimeout(t); this.timers.delete(id);
    this.cache = null;
    const m = this.get(id);
    if (!m) { this.live.delete(id); this.beats.delete(id); return; }
    if (forget) { this.live.delete(id); this.beats.set(id, Date.now()); }
    if (!this.live.has(id)) this.restore(id);
    if (m.enabled && !this.stopped && this.pruneTimer !== undefined) this.schedule(id, 0);
  }

  private schedule(id: string, delayMs: number): void {
    if (this.stopped) return;
    const t = setTimeout(() => void this.tick(id), delayMs); t.unref(); this.timers.set(id, t);
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy >= MAX_PARALLEL) await new Promise<void>(r => this.waiting.push(r));
    this.busy++;
    try { return await fn(); } finally { this.busy--; this.waiting.shift()?.(); }
  }

  private inMaintenance(id: string): boolean { return Boolean(this.windows.active(id, Date.now(), getSettings(this.db).timezone)); }

  private async tick(id: string): Promise<void> {
    const m = this.get(id); if (!m || !m.enabled || this.stopped) return;
    const before = this.lastTick.get(id) ?? 0;
    this.lastTick.set(id, Date.now());
    if (this.inMaintenance(id)) this.recordMaintenance(m);
    else if (m.kind === "push" && (this.beats.get(id) ?? 0) > before && before > 0) { /* a heartbeat arrived since the last look: it was recorded then */ }
    else await this.slot(() => this.checkNow(id, true));
    const m2 = this.get(id);
    if (!m2 || !m2.enabled || this.stopped) return;
    const pending = this.live.get(id)?.state === "pending";
    this.schedule(id, (pending ? Math.min(m2.retryIntervalSeconds, m2.intervalSeconds) : m2.intervalSeconds) * 1000);
  }

  /** Runs the check now, records it and returns what happened. */
  async checkNow(id: string, scheduled = false): Promise<(CheckResult & { state: MonitorState }) | undefined> {
    const m = this.spec(id); if (!m) return undefined;
    if (this.inMaintenance(id)) { this.recordMaintenance(m); return { up: true, ms: null, message: "In a maintenance window: not checked", state: "maintenance" }; }
    let r: CheckResult;
    if (m.kind === "push") {
      const age = Date.now() - (this.beats.get(id) ?? Date.now());
      r = age <= m.intervalSeconds * 1000 + (scheduled ? 0 : 2000) ? { up: true, ms: null, message: "Heartbeat is current" } : { up: false, ms: null, message: `No heartbeat for ${Math.round(age / 1000)} s` };
      if (m.upsideDown) r = { ...r, up: !r.up };
    } else r = await runCheck(m);
    if (!this.get(id)) return undefined; // removed while the check was running
    const state = this.record(m, r);
    return { ...r, state };
  }

  /** A script called the push address. */
  heartbeat(token: string, up: boolean, message: string, ms: number | null): boolean {
    const r = this.db.prepare("SELECT id FROM monitors WHERE kind = 'push' AND target = ? AND enabled = 1").get(token) as { id: string } | undefined;
    const m = r ? this.get(r.id) : undefined;
    if (!m) return false;
    this.beats.set(m.id, Date.now());
    if (this.inMaintenance(m.id)) this.recordMaintenance(m);
    else this.record(m, { up, ms, message: message.slice(0, 120) || (up ? "Heartbeat received" : "The script reported a problem") });
    return true;
  }

  private recordMaintenance(m: MonitorConfig): void {
    const now = Date.now(), prev = this.live.get(m.id);
    this.db.prepare("INSERT INTO monitor_checks (monitor_id, ts, s, ms, msg) VALUES (?, ?, 3, NULL, 'Maintenance window')").run(m.id, now);
    if (prev) { prev.lastAt = now; prev.fails = 0; }
    this.cache = null;
  }

  private record(m: MonitorConfig, r: CheckResult): MonitorState {
    const now = Date.now();
    const prev = this.live.get(m.id) ?? { state: "unknown" as MonitorState, since: now, fails: 0, lastAt: null, lastMs: null, message: "", certWarned: 0 };
    let shown: MonitorState, s: 0 | 1 | 2;
    if (r.up) { shown = "up"; s = 1; prev.fails = 0; }
    else { prev.fails++; if (prev.fails > m.retries) { shown = "down"; s = 0; } else { shown = "pending"; s = 2; } }
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
      if (r.certExpires && m.kind !== "cert" && m.certWarnDays > 0 && r.certExpires - now < m.certWarnDays * DAY && now - prev.certWarned > DAY) {
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
      const now = Date.now(), today = Math.floor(now / DAY), tz = getSettings(this.db).timezone, wins = this.windows.list();
      const raw24 = this.db.prepare("SELECT SUM(s = 1) AS up, SUM(s = 0) AS down, AVG(CASE WHEN s = 1 THEN ms END) AS avg FROM monitor_checks WHERE monitor_id = ? AND ts > ? AND s IN (0, 1)");
      const daily = this.db.prepare("SELECT COALESCE(SUM(up), 0) AS up, COALESCE(SUM(down), 0) AS down FROM monitor_daily WHERE monitor_id = ? AND day > ?");
      const strip = this.db.prepare("SELECT s FROM monitor_checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT 40");
      const cert = this.db.prepare("SELECT cert_expires AS c FROM monitors WHERE id = ?");
      this.cache = {
        at: now, rows: this.list().map(m => {
          const live = this.live.get(m.id);
          const d = raw24.get(m.id, now - DAY) as { up: number | null; down: number | null; avg: number | null };
          const d7 = daily.get(m.id, today - 7) as { up: number; down: number }, d30 = daily.get(m.id, today - 30) as { up: number; down: number };
          const maint = m.enabled && this.windows.active(m.id, now, tz, wins);
          return {
            id: m.id, name: m.name, group: m.group, description: m.description, kind: m.kind, enabled: m.enabled, state: !m.enabled ? "paused" : maint ? "maintenance" : live?.state ?? "unknown",
            since: live?.since ?? null, lastAt: live?.lastAt ?? null, lastMs: live?.lastMs ?? null, message: live?.message ?? "",
            uptime24h: pct(d.up ?? 0, d.down ?? 0), uptime7d: pct(d7.up, d7.down), uptime30d: pct(d30.up, d30.down),
            avgMs24h: d.avg === null ? null : Math.round(d.avg), certExpires: (cert.get(m.id) as { c: number | null }).c,
            strip: (strip.all(m.id) as unknown as Array<{ s: 0 | 1 | 2 | 3 }>).map(x => x.s).reverse(), config: m
          };
        })
      };
    }
    return this.cache.rows.map(r => admin ? r : { ...r, config: undefined });
  }

  /** Response times over the last `hours`, grouped so a chart gets at most about 120 points. Beyond 8 days the daily averages are used. */
  history(id: string, hours: number): Array<{ t: number; ms: number | null; down: boolean }> {
    const now = Date.now();
    if (hours > RAW_KEEP_DAYS * 24) {
      const days = Math.min(DAILY_KEEP_DAYS, Math.ceil(hours / 24));
      const rows = this.db.prepare("SELECT day, down, ms_sum, ms_n FROM monitor_daily WHERE monitor_id = ? AND day > ? ORDER BY day").all(id, Math.floor(now / DAY) - days) as unknown as Array<{ day: number; down: number; ms_sum: number; ms_n: number }>;
      return rows.map(r => ({ t: r.day * DAY, ms: r.ms_n ? Math.round(r.ms_sum / r.ms_n) : null, down: r.down > 0 }));
    }
    const span = Math.max(1, hours) * 3600_000;
    const bucket = Math.max(60_000, Math.ceil(span / 120 / 60_000) * 60_000);
    const rows = this.db.prepare("SELECT (ts / ?) * ? AS t, AVG(CASE WHEN s = 1 THEN ms END) AS ms, SUM(s = 0) AS down FROM monitor_checks WHERE monitor_id = ? AND ts > ? AND s IN (0, 1) GROUP BY t ORDER BY t")
      .all(bucket, bucket, id, now - span) as unknown as Array<{ t: number; ms: number | null; down: number }>;
    return rows.map(r => ({ t: r.t, ms: r.ms === null ? null : Math.round(r.ms), down: r.down > 0 }));
  }

  /** Uptime over several windows, from the daily totals (and the detailed checks for the last day). */
  uptimes(id: string): { d1: number | null; d7: number | null; d30: number | null; d90: number | null; d365: number | null } {
    const now = Date.now(), today = Math.floor(now / DAY);
    const one = this.db.prepare("SELECT COALESCE(SUM(s = 1), 0) AS up, COALESCE(SUM(s = 0), 0) AS down FROM monitor_checks WHERE monitor_id = ? AND ts > ? AND s IN (0, 1)").get(id, now - DAY) as { up: number; down: number };
    const span = (n: number) => { const r = this.db.prepare("SELECT COALESCE(SUM(up), 0) AS up, COALESCE(SUM(down), 0) AS down FROM monitor_daily WHERE monitor_id = ? AND day > ?").get(id, today - n) as { up: number; down: number }; return pct(r.up, r.down); };
    return { d1: pct(one.up, one.down), d7: span(7), d30: span(30), d90: span(90), d365: span(365) };
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

  /** The state changes (down and back up) of one monitor, newest first, found by looking for the points where the result flips. */
  events(id: string, limit = 30): Array<{ ts: number; up: boolean; msg: string }> {
    const rows = this.db.prepare("SELECT ts, s, msg FROM monitor_checks WHERE monitor_id = ? AND s IN (0, 1) ORDER BY ts DESC LIMIT 2000").all(id) as unknown as Array<{ ts: number; s: number; msg: string }>;
    const out: Array<{ ts: number; up: boolean; msg: string }> = [];
    for (let i = 0; i < rows.length && out.length < limit; i++) {
      const next = rows[i + 1];
      if (!next || next.s !== rows[i].s) out.push({ ts: rows[i].ts, up: rows[i].s === 1, msg: rows[i].msg });
    }
    return out;
  }
}

const duration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
};

// ================================================================ public status pages

export interface StatusPageRow { id: string; title: string; message: string; tone: string; monitors: string[]; enabled: boolean; createdAt: number; lastUsed: number | null; views: number }
interface PageRaw { id: string; title: string; message: string; tone: string; monitors: string; token_hash: string; token_sealed: string; enabled: number; created_at: number; last_used: number | null; views: number }
const PCOLS = "id, title, message, tone, monitors, token_hash, token_sealed, enabled, created_at, last_used, views";
const TONES = ["info", "warn", "bad"];
const mapPage = (r: PageRaw): StatusPageRow => ({ id: r.id, title: r.title, message: r.message, tone: r.tone, monitors: JSON.parse(r.monitors), enabled: Boolean(r.enabled), createdAt: r.created_at, lastUsed: r.last_used, views: r.views });

export class StatusPages {
  constructor(private db: DB, private box: SecretBox, private monitors: Monitors) {}

  list(): Array<StatusPageRow & { token: string }> {
    return (this.db.prepare(`SELECT ${PCOLS} FROM status_pages ORDER BY created_at DESC`).all() as unknown as PageRaw[]).map(r => ({ ...mapPage(r), token: this.box.open(r.token_sealed) }));
  }

  private clean(body: any, keep?: StatusPageRow) {
    const title = String(body?.title ?? keep?.title ?? "").trim();
    if (!title || title.length > 80) throw new ValidationError("Give the page a title (up to 80 characters)");
    const message = String(body?.message ?? keep?.message ?? "").trim().slice(0, 400);
    const tone = TONES.includes(String(body?.tone)) ? String(body.tone) : keep?.tone ?? "info";
    const have = new Set(this.monitors.list().map(m => m.id));
    const ids = [...new Set<string>((Array.isArray(body?.monitors) ? body.monitors : keep?.monitors ?? []).map(String))].filter(id => have.has(id));
    if (!ids.length) throw new ValidationError("Choose at least one monitor to show");
    return { title, message, tone, ids, enabled: body?.enabled === undefined ? (keep?.enabled ?? true) : Boolean(body.enabled) };
  }

  create(body: unknown) {
    const c = this.clean(body);
    const token = randomBytes(24).toString("base64url"), id = "p" + randomUUID().replace(/-/g, "").slice(0, 10);
    this.db.prepare(`INSERT INTO status_pages (${PCOLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`).run(id, c.title, c.message, c.tone, JSON.stringify(c.ids), hashToken(token), this.box.seal(token), c.enabled ? 1 : 0, Date.now());
    return this.list().find(p => p.id === id)!;
  }
  update(id: string, body: unknown) {
    const old = this.list().find(p => p.id === id); if (!old) return undefined;
    const c = this.clean(body, old);
    this.db.prepare("UPDATE status_pages SET title = ?, message = ?, tone = ?, monitors = ?, enabled = ? WHERE id = ?").run(c.title, c.message, c.tone, JSON.stringify(c.ids), c.enabled ? 1 : 0, id);
    return this.list().find(p => p.id === id);
  }
  /** A new address for the same page; the old one stops working. */
  rotate(id: string) {
    const token = randomBytes(24).toString("base64url");
    if (Number(this.db.prepare("UPDATE status_pages SET token_hash = ?, token_sealed = ? WHERE id = ?").run(hashToken(token), this.box.seal(token), id).changes) !== 1) return undefined;
    return this.list().find(p => p.id === id);
  }
  remove(id: string): boolean { return Number(this.db.prepare("DELETE FROM status_pages WHERE id = ?").run(id).changes) === 1; }

  /** What the public page shows. Names, groups, state and uptime only: never an address, a key or an error text. */
  publicView(token: string) {
    if (typeof token !== "string" || token.length < 20 || token.length > 80) return undefined;
    const r = this.db.prepare(`SELECT ${PCOLS} FROM status_pages WHERE token_hash = ?`).get(hashToken(token)) as PageRaw | undefined;
    if (!r || !r.enabled) return undefined;
    const page = mapPage(r);
    this.db.prepare("UPDATE status_pages SET views = views + 1, last_used = ? WHERE id = ?").run(Date.now(), page.id);
    const byId = new Map(this.monitors.view(false).map(m => [m.id, m]));
    const rows = page.monitors.map(id => byId.get(id)).filter((m): m is MonitorView => Boolean(m));
    const monitors = rows.map(m => ({ name: m.name, group: m.group, state: m.state, uptime24h: m.uptime24h, uptime30d: m.uptime30d, ms: m.lastMs, days: this.monitors.days(m.id, 45) }));
    const live = rows.filter(m => m.state !== "paused" && m.state !== "unknown" && m.state !== "maintenance");
    const down = live.filter(m => m.state === "down").length;
    const overall = !live.length ? (rows.some(m => m.state === "maintenance") ? "maintenance" : "unknown") : down === 0 ? "up" : down === live.length ? "down" : "degraded";
    return { title: page.title, message: page.message, tone: page.tone, overall, updatedAt: Date.now(), monitors };
  }
}

// ================================================================ backup file support

/** Monitors for a backup file. Passwords, request headers and push addresses are secrets and stay out of it; the import says which monitors need them again. */
export function exportMonitors(mon: Monitors, db: DB) {
  const monitors = mon.list().map(m => ({ ...m, headers: "", target: m.kind === "push" ? "" : m.target, secretsOmitted: Boolean(m.headers || m.hasAuthPass || m.kind === "push") }));
  const statusPages = (db.prepare(`SELECT ${PCOLS} FROM status_pages ORDER BY created_at`).all() as unknown as PageRaw[]).map(mapPage);
  return { monitors, statusPages: statusPages.map(({ id, title, message, tone, monitors: m, enabled }) => ({ id, title, message, tone, monitors: m, enabled })) };
}
