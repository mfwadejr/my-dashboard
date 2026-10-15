import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

/**
 * ZimaOS has no API keys. Its local API uses a session token from POST /v1/users/login (username and password; login is limited
 * to about 5 a minute, so the token is cached and reused). The "API key" field holds `username:password`, stored encrypted.
 * Response field names are only partly documented, so every value is read defensively and missing ones are left out.
 */
const tokens = new Map<string, { token: string; bearer: boolean; at: number }>();
const TOKEN_MS = 2 * 3600_000;

const num = (v: unknown): number | null => { const n = Number(v); return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? n : null; };
const unwrap = (doc: any) => (doc && typeof doc === "object" && "data" in doc && ("success" in doc || "message" in doc) ? doc.data : doc);

function credentials(ctx: Ctx): { username: string; password: string } {
  const i = ctx.apiKey.indexOf(":");
  if (i < 1 || i === ctx.apiKey.length - 1) throw new IntegrationError("Enter the ZimaOS login as username:password");
  return { username: ctx.apiKey.slice(0, i), password: ctx.apiKey.slice(i + 1) };
}

async function login(ctx: Ctx): Promise<string> {
  const { username, password } = credentials(ctx);
  let doc: any;
  try { doc = await getJson(ctx, "/v1/users/login", { body: { username, password } }); }
  catch (e) {
    if (e instanceof IntegrationError && (e.status === 401 || e.status === 403)) throw new IntegrationError("ZimaOS rejected that username or password");
    if (e instanceof IntegrationError && e.status === 429) throw new IntegrationError("ZimaOS is limiting logins (about 5 a minute). Wait a minute and try again");
    throw e;
  }
  if (doc && doc.success !== undefined && doc.success !== 200 && doc.success !== true) throw new IntegrationError(`ZimaOS login failed${doc.message ? ": " + String(doc.message) : ""}`);
  const t = unwrap(doc)?.token;
  const token = typeof t === "string" ? t : t?.access_token ?? t?.AccessToken;
  if (!token || typeof token !== "string") throw new IntegrationError("ZimaOS answered, but did not return a login token (is this the ZimaOS address?)");
  return token;
}

async function call(ctx: Ctx, path: string): Promise<any> {
  const key = `${ctx.url}|${ctx.apiKey}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let entry = tokens.get(key);
    if (!entry || Date.now() - entry.at > TOKEN_MS) { entry = { token: await login(ctx), bearer: entry?.bearer ?? false, at: Date.now() }; tokens.set(key, entry); }
    try {
      return unwrap(await getJson(ctx, path, { headers: { Authorization: entry.bearer ? `Bearer ${entry.token}` : entry.token } }));
    } catch (e) {
      if (e instanceof IntegrationError && (e.status === 401 || e.status === 403)) {
        // The first 401 may just mean the other header style; the second means the token is stale.
        if (attempt === 0) tokens.set(key, { ...entry, bearer: !entry.bearer });
        else tokens.delete(key);
        continue;
      }
      throw e;
    }
  }
  throw new IntegrationError("ZimaOS keeps rejecting the saved login token");
}

const items = (doc: any): any[] => (Array.isArray(doc) ? doc : Array.isArray(doc?.data) ? doc.data : Array.isArray(doc?.disks) ? doc.disks : []);

const PATHS = {
  utilization: "/v1/sys/utilization", version: "/v1/sys/version/check", hardware: "/v1/sys/hardware/info",
  systemDisk: "/v1/sys/disk", storage: "/v2/local_storage/disk", apps: "/v2/app_management/web/appgrid"
} as const;
type Name = keyof typeof PATHS | "containers" | "vms";

/** Containers and virtual machines have no documented list endpoint, so the likely ones are tried in order and the first that answers is used. */
const OPTIONAL = {
  containers: ["/v1/container", "/v2/app_management/compose", "/v2/app_management/container"],
  vms: ["/v2/vm", "/v2/virtual_machine", "/v1/vm"]
} as const;

async function firstOk(ctx: Ctx, paths: readonly string[]): Promise<{ path: string; doc: any } | null> {
  for (const path of paths) { try { return { path, doc: await call(ctx, path) }; } catch (e) { if (e instanceof IntegrationError && (e.status === 401 || e.status === 403)) throw e; } }
  return null;
}

/** Accepts a list, or a map of name → record (how compose apps are often keyed). */
function records(doc: any): any[] {
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.data) ? doc.data : Array.isArray(doc?.items) ? doc.items : null;
  if (list) return list.filter((x: any) => x && typeof x === "object");
  if (doc && typeof doc === "object") return Object.entries(doc).filter(([, v]) => v && typeof v === "object").map(([k, v]: [string, any]) => ({ name: k, ...v }));
  return [];
}
/** Titles may be a plain string or a language map such as {en_us: "Plex"}; the technical name (often compose-<hash>) is the last resort. */
function titleText(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object") {
    const m = v as Record<string, unknown>;
    const pick = m.en_us ?? m.en_US ?? m.en ?? Object.values(m).find(x => typeof x === "string" && x);
    if (typeof pick === "string" && pick.trim()) return pick.trim();
  }
  return null;
}
const label = (x: any, ...keys: string[]): string => {
  const candidates = [x?.title, x?.store_info?.title, x?.storeInfo?.title, x?.app_title, x?.display_name, x?.displayName, x?.["x-casaos"]?.title];
  for (const c of candidates) { const t = titleText(c); if (t) return t; }
  for (const k of keys) { const v = Array.isArray(x?.[k]) ? x[k][0] : x?.[k]; const t = titleText(v); if (t) return t.replace(/^\//, ""); }
  return "Unnamed";
};
const hasTitle = (x: any) => [x?.title, x?.store_info?.title, x?.storeInfo?.title, x?.app_title, x?.display_name, x?.displayName, x?.["x-casaos"]?.title].some(c => titleText(c));
/** Scalar field names and short values, so an unexpected response can be understood from the tile's tooltip. */
const hint = (x: any) => Object.entries(x ?? {}).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 12).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(", ");
const project = (c: any): string | null => { const l = c?.Labels ?? c?.labels; const p = l && typeof l === "object" ? l["com.docker.compose.project"] : null; return typeof p === "string" ? p : null; };
const stateOf = (x: any) => String(x?.state ?? x?.State ?? x?.status ?? x?.Status ?? "").toLowerCase();
const isRunning = (st: string) => /^(running|up|started|active)/.test(st);

async function readAll(ctx: Ctx): Promise<{ docs: Partial<Record<Name, any>>; failed: Name[] }> {
  const names = Object.keys(PATHS) as Array<keyof typeof PATHS>;
  const results = await Promise.allSettled(names.map(n => call(ctx, PATHS[n])));
  const docs: Partial<Record<Name, any>> = {}, failed: Name[] = [];
  results.forEach((r, i) => { if (r.status === "fulfilled") docs[names[i]] = r.value; else failed.push(names[i]); });
  // A login problem should surface as an error, not as "nothing available".
  const firstError = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed.length === names.length && firstError) throw firstError.reason;
  const [containers, vms] = await Promise.all([firstOk(ctx, OPTIONAL.containers), firstOk(ctx, OPTIONAL.vms)]);
  if (containers) docs.containers = containers.doc; else failed.push("containers");
  if (vms) docs.vms = vms.doc; else failed.push("vms");
  return { docs, failed };
}

function shape(d: Partial<Record<Name, any>>) {
  const cpu = d.utilization?.cpu, mem = d.utilization?.mem;
  const memTotal = num(mem?.total), memUsed = num(mem?.used);
  const memPct = num(mem?.usedPercent ?? mem?.used_percent) ?? (memTotal && memUsed !== null ? (memUsed / memTotal) * 100 : null);
  const sd = d.systemDisk;
  const sdTotal = num(sd?.size ?? sd?.total), sdUsed = num(sd?.used);
  const disks = items(d.storage).map(x => ({
    name: String(x.name ?? x.model ?? "Disk"), model: x.model ? String(x.model) : null, sizeB: num(x.size), tempC: num(x.temperature ?? x.temp), health: x.health !== undefined ? String(x.health) : null
  }));
  const apps = items(d.apps);
  const rawContainers = d.containers === undefined ? null : records(d.containers);
  const containerList = rawContainers === null ? null : rawContainers.map(c => { const st = stateOf(c); return { name: label(c, "Names", "name", "title"), image: typeof (c.Image ?? c.image) === "string" ? String(c.Image ?? c.image) : null, state: st || null, running: isRunning(st), hint: hint(c) }; }).slice(0, 80);
  // Apps whose record has no readable title (ZimaOS names them compose-<hash>) take the name of their own container instead.
  const appList = apps.map(a => {
    const st = stateOf(a); const id = typeof a.name === "string" ? a.name : null;
    let name = label(a, "name", "id");
    if (!hasTitle(a) && id && rawContainers) {
      const own = rawContainers.filter(c => project(c) === id).map(c => label(c, "Names", "name"));
      if (own.length) name = own.join(", ");
    }
    return { name, id, state: st || null, running: isRunning(st), hint: hint(a) };
  }).slice(0, 60);
  return {
    version: d.version?.current_version ?? d.version?.version ?? null, needUpdate: d.version?.need_update === true, latest: d.version?.version ?? null,
    arch: d.hardware?.arch ?? null, device: d.hardware?.drive_model ?? null,
    cpu: cpu ? { pct: num(cpu.percent), cores: num(cpu.num), tempC: num(cpu.temperature), powerW: num(cpu.power) } : null,
    mem: mem ? { pct: memPct, totalB: memTotal, usedB: memUsed } : null,
    systemDisk: sdTotal && sdUsed !== null ? { totalB: sdTotal, usedB: sdUsed, pct: Math.round((sdUsed / sdTotal) * 100) } : null,
    disks,
    appList: appList,
    containers: containerList,
    vms: d.vms === undefined ? null : records(d.vms).map(v => { const st = stateOf(v); return { name: label(v, "name", "title", "Name"), state: st || null, running: isRunning(st), hint: hint(v) }; }).slice(0, 40),
    apps: apps.length ? { total: apps.length, running: apps.filter(a => String(a.status ?? a.state ?? "").toLowerCase() === "running").length, known: apps.some(a => a.status !== undefined || a.state !== undefined) } : null
  };
}

async function test(ctx: Ctx): Promise<TestResult> {
  const { docs, failed } = await readAll(ctx);
  const s = shape(docs);
  const ok = [...(Object.keys(PATHS) as Name[]), "containers" as Name, "vms" as Name].filter(n => !failed.includes(n));
  const first = items(docs.apps)[0];
  const appFields = first ? `\nApp fields: ${Object.keys(first).slice(0, 20).join(", ")}` : "";
  return { ok: true, message: `Logged in to ZimaOS${s.version ? " " + s.version : ""}\nReadable: ${ok.join(", ") || "nothing"}${failed.length ? `\nNot available on this system: ${failed.join(", ")}` : ""}${appFields}`, version: s.version ?? undefined };
}

async function poll(ctx: Ctx): Promise<PollResult> {
  const { docs } = await readAll(ctx);
  const data = shape(docs);
  const metrics: Record<string, number> = {};
  const put = (k: string, v: number | null | undefined) => { if (typeof v === "number" && Number.isFinite(v)) metrics[k] = v; };
  put("cpu_pct", data.cpu?.pct); put("cpu_temp_c", data.cpu?.tempC); put("mem_pct", data.mem?.pct); put("system_disk_pct", data.systemDisk?.pct);
  put("apps_running", data.apps?.known ? data.apps.running : null);
  if (data.containers) put("containers_running", data.containers.filter(c => c.running).length);
  if (data.vms) put("vms_running", data.vms.filter(v => v.running).length);
  return { data, metrics };
}

export const zimaos: IntegrationType = {
  id: "zimaos", name: "ZimaOS",
  description: "CPU, memory, temperature, storage, installed apps and update status",
  urlHint: "http://192.168.1.20",
  keyLabel: "ZimaOS login as username:password (use a dedicated user if you can)",
  test, poll
};
