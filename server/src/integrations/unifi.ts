import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";
import { buildCatalog, readField, type FieldSel, type FieldUnit, type PickedValue } from "./unificatalog.js";

/** UniFi's official local APIs take the key as X-API-KEY and live under /proxy/<application>/integration/v1 on the console. */
const get = (ctx: Ctx, path: string, query?: Record<string, string | number>) => getJson(ctx, path, { headers: { "X-API-KEY": ctx.apiKey }, query });
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const items = (doc: any): any[] => (Array.isArray(doc) ? doc : Array.isArray(doc?.data) ? doc.data : []);
const settled = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

/** A 404 on a console usually means the wrong address or that application is not installed or too old. */
async function hinted<T>(app: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) {
    if (error instanceof IntegrationError && /HTTP 404/.test(error.message)) throw new IntegrationError(`The console answered, but has no ${app} API here. Use the console address (for example https://192.168.1.1), check ${app} is installed and up to date, and create the API key inside ${app}.`);
    throw error;
  }
}

// ---------------------------------------------------------------- Network

const NET = "/proxy/network/integration/v1";
const GATEWAY_MODEL = /^(UDM|UCG|UXG|UDR|UDW|UDMA|UDMPRO|USG|UCK)/i;

async function networkTest(ctx: Ctx): Promise<TestResult> {
  const info = await hinted("UniFi Network", () => get(ctx, `${NET}/info`));
  const version = info?.applicationVersion;
  return { ok: true, message: `Connected to UniFi Network${version ? " " + version : ""}`, version };
}


const bps = (bytesPerSec: unknown): number | null => { const n = firstNum(bytesPerSec); return n === null ? null : n * 8; };

/** Per-WAN link state and throughput from the gateway's classic device record (wan1, wan2, ...). Optional: an API key may not be accepted there. */
export function extractWans(classic: any): Array<{ name: string; ifname: string; up: boolean | null; ip: string; rxBps: number | null; txBps: number | null; speedMbps: number | null; type: string; group?: string; balanced?: boolean; active: boolean | null; latencyMs: number | null; availabilityPct: number | null }> {
  if (!classic || typeof classic !== "object") return [];
  const stats = classic.uptime_stats && typeof classic.uptime_stats === "object" ? classic.uptime_stats : {};
  // Which link carries the traffic now: the gateway names its current uplink (wan1, wan2 or the interface), or a link says so itself.
  const uplink = String(classic.uplink?.name ?? classic.uplink?.ifname ?? classic.uplink?.uplink_ifname ?? "").toLowerCase();
  return Object.keys(classic).filter(k => /^wan\d*$/i.test(k) && classic[k] && typeof classic[k] === "object").sort().map(k => {
    const w = classic[k], key = k.toUpperCase(), st = stats[key] ?? stats[k] ?? (key === "WAN1" ? stats.WAN : null) ?? null; // the first link is often just "WAN"
    const ifname = String(w.ifname ?? "");
    const active = uplink ? uplink === k.toLowerCase() || (ifname !== "" && uplink === ifname.toLowerCase()) : w.is_uplink === undefined ? null : truthy(w.is_uplink);
    return {
      name: String(w.name ?? k.toUpperCase()), ifname, up: w.up === undefined ? null : truthy(w.up), ip: String(w.ip ?? ""),
      rxBps: bps(w["rx_bytes-r"]), txBps: bps(w["tx_bytes-r"]), speedMbps: firstNum(w.speed), type: String(w.type ?? ""), group: String(w.wan_networkgroup ?? w.networkgroup ?? w.network_name ?? "").toUpperCase(),
      active, latencyMs: firstNum(st?.latency_average, w.latency), availabilityPct: firstNum(st?.availability)
    };
  });
}

function extractSpeedtest(classic: any) {
  const t = classic?.["speedtest-status"];
  if (!t || typeof t !== "object") return null;
  const down = firstNum(t.xput_download), up = firstNum(t.xput_upload);
  if (down === null && up === null) return null;
  return { downMbps: down, upMbps: up, latencyMs: firstNum(t.latency), at: firstNum(t.rundate) };
}

function extractTemp(classic: any): number | null {
  const direct = firstNum(classic?.general_temperature, classic?.temperature);
  if (direct !== null) return direct;
  const list = Array.isArray(classic?.temperatures) ? classic.temperatures : [];
  const v = list.map((t: any) => firstNum(t?.value)).filter((x: number | null): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
}

const classicDevice = (ctx: Ctx, siteName: string, mac: unknown) =>
  mac ? get(ctx, `/proxy/network/api/s/${siteName}/stat/device/${encodeURIComponent(String(mac))}`).then(r => items(r?.data ? r.data : r)[0] ?? null).catch(() => null) : Promise.resolve(null);

// ---------------------------------------------------------------- Pickable fields, live WAN rates

type Entries = Record<string, { label: string; doc: any }>;
type Sources = Partial<Record<"health" | "sysinfo" | "devices" | "clients", Entries>>;
const CLIENT_KEEP = ["name", "hostname", "ip", "network", "essid", "is_wired", "uptime", "signal", "rssi", "channel", "satisfaction", "rx_bytes-r", "tx_bytes-r", "rx_bytes", "tx_bytes"];

const classicRows = async (ctx: Ctx, siteName: string, path: string): Promise<any[]> => {
  const doc = await get(ctx, `/proxy/network/api/s/${siteName}/${path}`);
  return items(doc?.data ? doc.data : doc);
};

/** Fetches the classic documents that the wanted sources need. A document the console will not give is left out and noted. */
async function gatherSources(ctx: Ctx, siteName: string, need: Set<string>, topClients = 0): Promise<{ sources: Sources; notes: string[] }> {
  const sources: Sources = {}, notes: string[] = [];
  const job = (name: string, fn: () => Promise<void>) => fn().catch(e => { notes.push(`${name} is not available${e instanceof IntegrationError ? ` (${e.message.replace(/^The app (answered with )?/, "").slice(0, 80)})` : ""}`); });
  await Promise.all([
    need.has("health") && job("Site health", async () => {
      const rows = await classicRows(ctx, siteName, "stat/health");
      sources.health = Object.fromEntries(rows.filter(r => r?.subsystem).map(r => [String(r.subsystem), { label: String(r.subsystem).toUpperCase(), doc: r }]));
    }),
    need.has("sysinfo") && job("Controller information", async () => {
      const rows = await classicRows(ctx, siteName, "stat/sysinfo");
      if (rows[0]) sources.sysinfo = { controller: { label: "Controller", doc: rows[0] } };
    }),
    need.has("devices") && job("The device list", async () => {
      const rows = await classicRows(ctx, siteName, "stat/device");
      sources.devices = Object.fromEntries(rows.filter(r => r?.mac).map(r => [String(r.mac).toLowerCase(), { label: String(r.name ?? r.model ?? r.mac), doc: r }]));
    }),
    need.has("clients") && job("The client list", async () => {
      let rows = await classicRows(ctx, siteName, "stat/sta");
      rows = rows.filter(r => r?.mac);
      if (topClients) rows = rows.sort((a, b) => num(b["rx_bytes-r"]) + num(b["tx_bytes-r"]) - num(a["rx_bytes-r"]) - num(a["tx_bytes-r"])).slice(0, topClients);
      sources.clients = Object.fromEntries(rows.slice(0, 1000).map(r => [String(r.mac).toLowerCase(), { label: String(r.name ?? r.hostname ?? r.mac), doc: Object.fromEntries(CLIENT_KEEP.filter(k => r[k] !== undefined).map(k => [k, r[k]])) }]));
    })
  ].filter(Boolean) as Array<Promise<void>>);
  return { sources, notes };
}

interface SiteInfo { siteId: string; siteName: string; gw: { id: string; mac: string; name: string } | null; at: number }
const siteCache = new Map<string, SiteInfo>();

/** The site and the gateway, remembered for a few minutes so the fast sampler does not look them up every time. */
async function siteInfo(ctx: Ctx): Promise<SiteInfo> {
  const key = `${ctx.url}|${ctx.apiKey.slice(-8)}`, hit = siteCache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit;
  const sites = items(await get(ctx, `${NET}/sites`, { limit: 200 }));
  const site = sites.find(s => s?.internalReference === "default") ?? sites[0];
  if (!site?.id) throw new IntegrationError("UniFi Network returned no sites");
  const devices = items(await get(ctx, `${NET}/sites/${site.id}/devices`, { limit: 200 }));
  const g = devices.find(d => GATEWAY_MODEL.test(String(d?.model ?? "")) || /gateway/i.test(String(d?.type ?? "")));
  const info: SiteInfo = { siteId: String(site.id), siteName: encodeURIComponent(String(site.internalReference ?? "default")), gw: g?.id ? { id: String(g.id), mac: String(g.macAddress ?? g.mac ?? ""), name: String(g.name ?? g.model ?? "Gateway") } : null, at: Date.now() };
  siteCache.set(key, info);
  return info;
}

/** Everything the console shows, as pickable fields. */
async function networkCatalog(ctx: Ctx) {
  const site = await siteInfo(ctx);
  const { sources, notes } = await gatherSources(ctx, site.siteName, new Set(["health", "sysinfo", "devices", "clients"]), 25);
  // The gateway's own record is what the tile reads (it carries the temperature and per-link numbers), so use it in the list as well.
  const mac = site.gw?.mac.toLowerCase();
  if (mac && sources.devices) {
    const own = await classicDevice(ctx, site.siteName, site.gw!.mac);
    if (own) sources.devices[mac] = { label: sources.devices[mac]?.label ?? site.gw!.name, doc: { ...(sources.devices[mac]?.doc ?? {}), ...own } };
  }
  const fields = buildCatalog(sources);
  if (!fields.length) notes.push("The console gave no readable fields. The classic network API may not accept this API key on your version.");
  if (sources.clients) notes.push("Clients: the 25 busiest right now are listed; others can be added once they are active.");
  return { fields, notes };
}

/** The gateway's WAN rates, for the fast sampler: one small document per sample. */
async function wanSample(ctx: Ctx): Promise<Record<string, number | null>> {
  const site = await siteInfo(ctx);
  if (!site.gw?.mac) throw new IntegrationError("No gateway was found to read WAN rates from");
  const doc = await classicDevice(ctx, site.siteName, site.gw.mac);
  if (!doc) throw new IntegrationError("The gateway did not answer the classic device request");
  const wans = extractWans(doc), out: Record<string, number | null> = {};
  wans.forEach((w, i) => { out[`wan${i + 1}_rx_bps`] = w.rxBps; out[`wan${i + 1}_tx_bps`] = w.txBps; });
  const sys = doc["system-stats"] ?? {};
  out.cpu_pct = firstNum(sys.cpu); out.mem_pct = firstNum(sys.mem); out.temp_c = extractTemp(doc); out.uptime_s = firstNum(sys.uptime, doc.uptime);
  wans.forEach((w, i) => { out[`wan${i + 1}_up`] = w.up === null ? null : w.up ? 1 : 0; });
  out.rx_bps = wans.reduce<number | null>((a, w) => (w.rxBps === null ? a : (a ?? 0) + w.rxBps), null);
  out.tx_bps = wans.reduce<number | null>((a, w) => (w.txBps === null ? a : (a ?? 0) + w.txBps), null);
  return out;
}

/**
 * The gateway's own record names a link by its port (eth8). The names you gave your internet connections (WAN 1, T-Mobile) live in the
 * network settings, so they are matched by the link's WAN group, then by the settings' own order, and the port is kept as detail.
 */
export function nameWans<T extends { name: string; ifname: string; group?: string; up?: boolean | null }>(wans: T[], confs: any[]): T[] {
  const named = confs.filter(c => String(c?.purpose ?? "").toLowerCase() === "wan" && typeof c?.name === "string" && c.name.trim())
    .sort((a, b) => String(a.wan_networkgroup ?? "").localeCompare(String(b.wan_networkgroup ?? ""), "en", { numeric: true }));
  if (!named.length) return wans;
  return wans.map((w, i) => {
    const byGroup = w.group ? named.find(c => String(c.wan_networkgroup ?? "").toUpperCase() === w.group || String(c.name).toUpperCase() === w.group) : undefined;
    const hit = byGroup ?? (named.length === wans.length ? named[i] : undefined);
    if (!hit) return w;
    // In load-balanced mode the gateway names only one uplink, but every working link carries traffic.
    const balanced = /weight|balance/i.test(String(hit.wan_load_balance_type ?? "")) && !/failover/i.test(String(hit.wan_load_balance_type));
    return { ...w, name: String(hit.name).trim().slice(0, 40), ifname: w.ifname || (/^[a-z]+\d+$/i.test(w.name) ? w.name : ""), ...(balanced ? { balanced: true, active: w.up === false ? false : true } : {}) };
  });
}

const AP_MODEL = /^(U6|U7|UAP|UWB|E7|UK|U-?LR|UBB)/i;
const isAp = (d: any) => (Array.isArray(d?.features) ? d.features.some((f: any) => /access.?point/i.test(String(f))) : AP_MODEL.test(String(d?.model ?? "")));

async function networkPoll(ctx: Ctx): Promise<PollResult> {
  const info = await hinted("UniFi Network", () => get(ctx, `${NET}/info`));
  const sites = items(await get(ctx, `${NET}/sites`, { limit: 200 }));
  const site = sites.find(s => s?.internalReference === "default") ?? sites[0];
  if (!site?.id) throw new IntegrationError("UniFi Network returned no sites");
  const [devicesDoc, clientsDoc, networksDoc, wifiDoc, wansDoc] = await Promise.allSettled([
    get(ctx, `${NET}/sites/${site.id}/devices`, { limit: 200 }),
    get(ctx, `${NET}/sites/${site.id}/clients`, { limit: 200 }),
    get(ctx, `${NET}/sites/${site.id}/networks`, { limit: 200 }),
    get(ctx, `${NET}/sites/${site.id}/wifi/broadcasts`, { limit: 200 }),
    get(ctx, `${NET}/sites/${site.id}/wans`, { limit: 50 })
  ]);
  const devices = items(settled(devicesDoc));
  const okStates = new Set(["ONLINE", "UPDATING", "GETTING_READY", "ADOPTING"]);
  const problem = devices.filter(d => d?.state && !okStates.has(String(d.state).toUpperCase()));

  const cdoc = settled(clientsDoc);
  const clients = items(cdoc);
  const totalClients = cdoc ? num(cdoc.totalCount ?? clients.length) : null;
  const typeOf = (c: any) => String(c?.type ?? "").toUpperCase();
  const exact = cdoc ? clients.length >= totalClients! : false;

  // Gateway load and WAN rate come from the gateway's latest statistics. Missing fields are simply left out.
  const gw = devices.find(d => GATEWAY_MODEL.test(String(d?.model ?? "")) || /gateway/i.test(String(d?.type ?? "")));
  let gateway: any = null;
  let wans: any[] = [];
  let speedtest: any = null;
  const siteName = encodeURIComponent(String(site.internalReference ?? "default"));
  if (gw?.id) {
    const stats = await get(ctx, `${NET}/sites/${site.id}/devices/${gw.id}/statistics/latest`).catch(() => null);
    const up = stats?.uplink ?? {};
    gateway = {
      name: String(gw.name ?? gw.model ?? "Gateway"), model: String(gw.model ?? ""),
      cpuPct: stats?.cpuUtilizationPct ?? null, memPct: stats?.memoryUtilizationPct ?? null, uptimeSec: stats?.uptimeSec ?? null,
      txBps: up.txRateBps ?? null, rxBps: up.rxRateBps ?? null,
      load1: firstNum(stats?.loadAverage1Min), tempC: null as number | null
    };
    const classicGw = await classicDevice(ctx, siteName, gw.macAddress ?? gw.mac);
    wans = nameWans(extractWans(classicGw), await classicRows(ctx, siteName, "rest/networkconf").catch(() => []));
    speedtest = extractSpeedtest(classicGw);
    gateway.tempC = extractTemp(classicGw);
  }
  // When the classic record is not available, the Integration API still names the WANs even though it has no per-WAN rates.
  if (!wans.length) wans = items(settled(wansDoc)).map((w: any) => ({ name: String(w?.name ?? w?.id ?? "WAN"), ifname: "", up: null, ip: "", rxBps: null, txBps: null, speedMbps: null, type: "", active: null, latencyMs: null, availabilityPct: null }));
  // Site health gives the public address; the picked fields are read from the same documents.
  const picked = ctx.fields ?? [];
  const need = new Set<string>(["health", ...picked.map(f => f.path.split("/")[0] ?? "")]);
  const { sources, notes: sourceNotes } = await gatherSources(ctx, siteName, need);
  const publicIp = (() => { const v = sources.health?.wan?.doc?.wan_ip; return typeof v === "string" && v ? v : null; })();
  const custom = picked.map(f => ({ path: f.path, label: f.label, unit: f.unit, value: readField(sources, f.path) }));
  const apDevices = devices.filter(isAp);
  const byAp = new Map<string, number>();
  if (cdoc && exact) for (const c of clients) if (typeOf(c) === "WIRELESS" && c?.uplinkDeviceId) byAp.set(String(c.uplinkDeviceId), (byAp.get(String(c.uplinkDeviceId)) ?? 0) + 1);
  const aps = apDevices.map(d => ({ name: String(d.name ?? d.model), model: String(d.model ?? ""), state: String(d.state ?? ""), clients: exact ? byAp.get(String(d.id)) ?? 0 : null }));
  const wifi = items(settled(wifiDoc)).map((w: any) => ({ name: String(w?.name ?? w?.ssid ?? "Wi-Fi"), enabled: w?.enabled !== false, security: String(w?.securityConfiguration?.type ?? w?.security ?? "") }));
  const networks = items(settled(networksDoc)).map((n: any) => ({ name: String(n?.name ?? "Network"), vlan: firstNum(n?.vlanId), enabled: n?.enabled !== false }));
  // PDUs are Network devices, so the PDU tile can read them from this same connection.
  const pdus = devicesDoc.status === "fulfilled" ? await readPdus(ctx, site, devices).catch(() => []) : [];
  const data = {
    version: info?.applicationVersion ?? null,
    pdus,
    site: { id: String(site.id), name: String(site.name ?? "Default") },
    devices: devicesDoc.status === "fulfilled" ? { total: devices.length, online: devices.length - problem.length, offline: problem.length, problems: problem.slice(0, 6).map(d => ({ name: String(d.name ?? d.model ?? "Device"), model: String(d.model ?? ""), state: String(d.state) })) } : null,
    clients: totalClients === null ? null : { total: totalClients, wired: exact ? clients.filter(c => typeOf(c) === "WIRED").length : null, wireless: exact ? clients.filter(c => typeOf(c) === "WIRELESS").length : null },
    gateway, wans, publicIp, custom, customNotes: picked.length ? sourceNotes : [], speedtest, aps, wifi, networks,
    deviceList: devicesDoc.status === "fulfilled" ? devices.map(d => ({ name: String(d.name ?? d.model ?? "Device"), model: String(d.model ?? ""), state: String(d.state ?? ""), firmware: String(d.firmwareVersion ?? ""), updatable: d.firmwareUpdatable === true })) : null
  };
  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(pduMetrics(pdus))) metrics[`pdu_${k}`] = v;
  if (data.clients) metrics.clients = data.clients.total;
  if (data.devices) { metrics.devices_total = data.devices.total; metrics.devices_offline = data.devices.offline; }
  wans.forEach((w, i) => { if (w.rxBps !== null) metrics[`wan${i + 1}_rx_bps`] = w.rxBps; if (w.txBps !== null) metrics[`wan${i + 1}_tx_bps`] = w.txBps; });
  if (gateway) {
    for (const [k, v] of Object.entries({ cpu_pct: gateway.cpuPct, mem_pct: gateway.memPct, wan_tx_bps: gateway.txBps, wan_rx_bps: gateway.rxBps })) if (typeof v === "number") metrics[k] = v;
  }
  return { data, metrics };
}

// ---------------------------------------------------------------- Protect

const PROT = "/proxy/protect/integration/v1";

async function protectTest(ctx: Ctx): Promise<TestResult> {
  const info = await hinted("UniFi Protect", () => get(ctx, `${PROT}/meta/info`));
  const version = info?.applicationVersion;
  return { ok: true, message: `Connected to UniFi Protect${version ? " " + version : ""}`, version };
}

async function protectPoll(ctx: Ctx): Promise<PollResult> {
  const info = await hinted("UniFi Protect", () => get(ctx, `${PROT}/meta/info`));
  const [cams, sensors, lights, chimes, nvrs] = await Promise.allSettled(["cameras", "sensors", "lights", "chimes", "nvrs"].map(p => get(ctx, `${PROT}/${p}`)));
  const cameras = items(settled(cams));
  const down = cameras.filter(c => String(c?.state ?? "").toUpperCase() !== "CONNECTED");
  const count = (r: PromiseSettledResult<any>) => (r.status === "fulfilled" ? items(r.value).length : null);
  const nvr = items(settled(nvrs))[0] ?? (settled(nvrs) && !Array.isArray(settled(nvrs)) ? settled(nvrs) : null);
  const data = {
    version: info?.applicationVersion ?? null,
    nvr: nvr?.name ? String(nvr.name) : null,
    cameras: { total: cameras.length, connected: cameras.length - down.length, disconnected: down.length, problems: down.slice(0, 8).map(c => ({ name: String(c.name ?? "Camera"), state: String(c.state ?? "UNKNOWN") })) },
    others: { sensors: count(sensors), lights: count(lights), chimes: count(chimes) }
  };
  return { data, metrics: { cameras_total: data.cameras.total, cameras_offline: data.cameras.disconnected } };
}

/** Cameras on a Protect console, for importing into the camera wall. */
export async function protectCameras(ctx: Ctx): Promise<Array<{ id: string; name: string; state: string }>> {
  const doc = await hinted("UniFi Protect", () => get(ctx, `${PROT}/cameras`));
  let list = items(doc);
  if (!list.length && doc && !Array.isArray(doc) && Array.isArray(doc.cameras)) list = doc.cameras;
  if (!list.length && doc && typeof doc === "object" && !Array.isArray(doc) && Object.keys(doc).length > 0 && !("data" in doc)) {
    throw new IntegrationError(`Protect answered, but not with a list of cameras (it sent: ${Object.keys(doc).slice(0, 8).join(", ")})`);
  }
  return list.filter(c => typeof c?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(c.id)).map(c => ({ id: String(c.id), name: String(c.name ?? "Camera").slice(0, 60), state: String(c.state ?? "UNKNOWN") }));
}

/** The RTSPS address(es) Protect hands out for a camera. Asks for existing ones first, and creates them only if there are none. */
export async function protectStreams(ctx: Ctx, cameraId: string): Promise<{ main: string; sub: string }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cameraId)) throw new IntegrationError("That is not a valid camera id");
  const path = `${PROT}/cameras/${cameraId}/rtsps-stream`;
  const urls = (doc: any) => ({ high: String(doc?.high ?? ""), medium: String(doc?.medium ?? ""), low: String(doc?.low ?? "") });
  let u = urls(await get(ctx, path).catch(() => null));
  if (!u.high && !u.medium && !u.low) u = urls(await getJson(ctx, path, { headers: { "X-API-KEY": ctx.apiKey }, body: { qualities: ["high", "low"] } }));
  const main = u.high || u.medium || u.low;
  if (!main) throw new IntegrationError("UniFi Protect did not return a stream address for this camera");
  const sub = [u.low, u.medium].find(x => x && x !== main) ?? "";
  return { main, sub };
}

// ---------------------------------------------------------------- PDU (a Network device)

const PDU_MODEL = /pdu/i;
const truthy = (v: unknown): boolean | null => (typeof v === "boolean" ? v : typeof v === "string" ? ["on", "true", "1", "enabled"].includes(v.toLowerCase()) : typeof v === "number" ? v !== 0 : null);
const firstNum = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
};

export interface Outlet { index: number; name: string; on: boolean | null; powerW: number | null; currentA: number | null; voltageV: number | null; metered: boolean; raw?: string }

/**
 * Outlets come from the classic `outlet_table` when the console allows it. Otherwise this looks for any list under a key
 * containing "outlet" in the Integration API responses, accepting the common spellings, because those field names are not published.
 */
export function extractOutlets(...docs: any[]): Outlet[] {
  for (const doc of docs) {
    if (!doc || typeof doc !== "object") continue;
    const key = Object.keys(doc).find(k => /outlet/i.test(k) && Array.isArray(doc[k]) && doc[k].length && typeof doc[k][0] === "object");
    if (!key) continue;
    return (doc[key] as any[]).map((o, i) => {
      const caps = firstNum(o.outlet_caps, o.caps);
      const powerW = firstNum(o.outlet_power, o.power, o.power_w, o.powerW, o.powerWatts, o.outletPowerW, o.watts, o.active_power);
      return {
        index: firstNum(o.index, o.outletIndex, o.id) ?? i + 1,
        name: String(o.name ?? o.label ?? `Outlet ${i + 1}`),
        on: truthy(o.relay_state ?? o.relayState ?? o.state ?? o.on ?? o.isOn ?? o.enabled),
        powerW, currentA: firstNum(o.outlet_current, o.current, o.currentA), voltageV: firstNum(o.outlet_voltage, o.voltage, o.voltageV),
        raw: Object.entries(o).filter(([, v]) => ["number", "string", "boolean"].includes(typeof v)).slice(0, 14).map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join(", "),
        metered: powerW !== null || (caps !== null && (caps & 2) === 2)
      };
    });
  }
  return [];
}

function totalWatts(...docs: any[]): number | null {
  for (const doc of docs) {
    if (!doc || typeof doc !== "object") continue;
    const v = firstNum(doc.outlet_ac_power_consumption, doc.total_power, doc.powerConsumptionW, doc.totalPowerW, doc.acPowerConsumptionW, doc.power_consumption, doc.sum_power);
    if (v !== null) return v;
  }
  return null;
}

/** Key names only (never values) that look power-related, so the real field names can be confirmed on real hardware. */
function powerFieldHint(classic: any): string {
  if (!classic || typeof classic !== "object") return "";
  const dev = Object.keys(classic).filter(k => /power|watt|outlet|current|volt/i.test(k)).slice(0, 12);
  const first = Array.isArray(classic.outlet_table) && classic.outlet_table[0] && typeof classic.outlet_table[0] === "object" ? Object.keys(classic.outlet_table[0]).slice(0, 16) : [];
  return `device: ${dev.join(",")} | outlet: ${first.join(",")}`;
}

function inputVoltage(classic: any, outlets: Outlet[]): number | null {
  const v = firstNum(classic?.ac_input_voltage, classic?.input_voltage, classic?.voltage, classic?.outlet_ac_voltage);
  if (v !== null) return v;
  const vs = outlets.map(o => o.voltageV).filter((x): x is number => x !== null && x > 0);
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
}

function totalCurrent(classic: any, outlets: Outlet[]): number | null {
  const v = firstNum(classic?.ac_input_current, classic?.input_current, classic?.total_current);
  if (v !== null) return v;
  const cs = outlets.map(o => o.currentA).filter((x): x is number => x !== null);
  return cs.length ? cs.reduce((a, b) => a + b, 0) : null;
}

async function readPdus(ctx: Ctx, site: any, devices: any[]) {
  const found = devices.filter(d => PDU_MODEL.test(`${d?.model ?? ""} ${d?.type ?? ""}`)).slice(0, 4);
  const siteName = encodeURIComponent(String(site.internalReference ?? "default"));
  const pdus = [];
  for (const d of found) {
    const [detail, stats, classic] = await Promise.all([
      get(ctx, `${NET}/sites/${site.id}/devices/${d.id}`).catch(() => null),
      get(ctx, `${NET}/sites/${site.id}/devices/${d.id}/statistics/latest`).catch(() => null),
      // The classic API is what exposes per-outlet power on current firmware. An API key may not be accepted there, so it is optional.
      (d.macAddress ?? d.mac) ? get(ctx, `/proxy/network/api/s/${siteName}/stat/device/${encodeURIComponent(String(d.macAddress ?? d.mac))}`).then(r => items(r?.data ? r.data : r)[0] ?? null).catch(() => null) : Promise.resolve(null)
    ]);
    const outlets = extractOutlets(classic, stats, detail);
    const budget = firstNum(classic?.outlet_ac_power_budget);
    const watts = totalWatts(classic, stats, detail) ?? (outlets.some(o => o.powerW !== null) ? outlets.reduce((a, o) => a + (o.powerW ?? 0), 0) : null);
    pdus.push({
      id: String(d.id), name: String(d.name ?? d.model), model: String(d.model ?? ""), state: String(d.state ?? ""),
      uptimeSec: firstNum(stats?.uptimeSec), totalW: watts, budgetW: budget,
      source: classic?.outlet_table ? "classic" : outlets.length ? "integration" : "none", outlets,
      voltageV: inputVoltage(classic, outlets), currentA: totalCurrent(classic, outlets),
      fields: powerFieldHint(classic)
    });
  }
  return pdus;
}

function pduMetrics(pdus: Array<{ totalW: number | null; outlets: Outlet[] }>): Record<string, number> {
  const first = pdus[0];
  const metrics: Record<string, number> = {};
  if (first?.totalW != null) metrics.power_w = first.totalW;
  if (first?.outlets.length) metrics.outlets_on = first.outlets.filter(o => o.on).length;
  return metrics;
}

async function pduPoll(ctx: Ctx): Promise<PollResult> {
  const sites = items(await hinted("UniFi Network", () => get(ctx, `${NET}/sites`, { limit: 200 })));
  const site = sites.find(s => s?.internalReference === "default") ?? sites[0];
  if (!site?.id) throw new IntegrationError("UniFi Network returned no sites");
  const devices = items(await get(ctx, `${NET}/sites/${site.id}/devices`, { limit: 200 }));
  const pdus = await readPdus(ctx, site, devices);
  return { data: { site: String(site.name ?? "Default"), pdus }, metrics: pduMetrics(pdus) };
}

// ---------------------------------------------------------------- Probe (UNAS, PDU and anything else without a documented API)

const CANDIDATES = [
  "/proxy/network/integration/v1/info", "/proxy/protect/integration/v1/meta/info",
  "/proxy/drive/integration/v1/info", "/proxy/drive/integration/v1/storage", "/proxy/drive/integration/v1/drives", "/proxy/drive/api/v1/info",
  "/proxy/access/integration/v1/info", "/api/v1/info"
];

/** Key names only, never values, so the result is safe to paste into a chat. */
function shape(doc: any): string {
  if (Array.isArray(doc)) return `list of ${doc.length}${doc[0] && typeof doc[0] === "object" ? ` {${Object.keys(doc[0]).slice(0, 14).join(", ")}}` : ""}`;
  if (doc && typeof doc === "object") return `{${Object.keys(doc).slice(0, 14).join(", ")}}`;
  return typeof doc;
}

async function probe(ctx: Ctx): Promise<{ lines: string[]; any: boolean }> {
  const lines: string[] = [];
  let any = false;
  for (const path of CANDIDATES) {
    try { const doc = await get(ctx, path); any = true; lines.push(`OK   ${path} → ${shape(doc)}`); }
    catch (e) { lines.push(`--   ${path} → ${(e instanceof Error ? e.message : "failed").replace(/^The app (answered with )?/, "").replace(ctx.url, "console")}`); }
  }
  // PDUs and other adopted gear show up as Network devices, so list those and what their statistics expose.
  try {
    const sites = items(await get(ctx, `${NET}/sites`, { limit: 5 }));
    const site = sites[0];
    if (site?.id) {
      const devices = items(await get(ctx, `${NET}/sites/${site.id}/devices`, { limit: 200 }));
      lines.push(`Network devices: ${devices.length} (${[...new Set(devices.map(d => String(d.model ?? d.type ?? "?")))].slice(0, 12).join(", ")})`);
      for (const d of devices.filter(d => /pdu|power|una?s|nas|drive/i.test(`${d.model} ${d.type} ${d.name}`)).slice(0, 3)) {
        const detail = await get(ctx, `${NET}/sites/${site.id}/devices/${d.id}`).catch(() => null);
        const stats = await get(ctx, `${NET}/sites/${site.id}/devices/${d.id}/statistics/latest`).catch(() => null);
        lines.push(`Found ${d.model ?? d.type} “${d.name}” (${d.state}); detail ${detail ? shape(detail) : "unavailable"}; statistics ${stats ? shape(stats) : "unavailable"}`);
      }
      any = true;
    }
  } catch { /* the Network API may simply not be reachable with this key */ }
  return { lines, any };
}

export const unifiNetwork: IntegrationType = {
  id: "unifi-network", name: "UniFi Network",
  description: "Clients, devices online or offline, gateway load and WAN rate",
  urlHint: "https://192.168.1.1",
  keyLabel: "API key (UniFi Network → Settings → Control Plane → Integrations)",
  test: networkTest, poll: networkPoll,
  live: { intervalMs: 2000, sample: wanSample },
  catalog: networkCatalog
};

export const unifiProtect: IntegrationType = {
  id: "unifi-protect", name: "UniFi Protect",
  description: "Cameras connected or offline, sensors, lights and chimes",
  urlHint: "https://192.168.1.1",
  keyLabel: "API key (UniFi Protect → Settings → Integrations)",
  test: protectTest, poll: protectPoll
};

export const unifiPdu: IntegrationType = {
  id: "unifi-pdu", name: "UniFi PDU",
  description: "Power draw and outlet states for UniFi PDUs adopted in UniFi Network",
  urlHint: "https://192.168.1.1",
  keyLabel: "API key (UniFi Network → Settings → Control Plane → Integrations)",
  async test(ctx) {
    const base = await networkTest(ctx);
    const data = (await pduPoll(ctx)).data as any;
    const n = data.pdus.length;
    return { ok: true, message: n ? `${base.message} · found ${n} PDU${n === 1 ? "" : "s"} (${data.pdus.map((p: any) => p.name).join(", ")})` : `${base.message} · connected, but no PDU is adopted in site “${data.site}”` };
  },
  poll: pduPoll
};

export const unifiProbe: IntegrationType = {
  id: "unifi-probe", name: "UniFi probe (UNAS / PDU)",
  description: "Checks which API addresses your UNAS, PDU or console answers, so those tiles can be built from real responses",
  urlHint: "https://192.168.1.1",
  keyLabel: "API key",
  async test(ctx) {
    const { lines, any } = await probe(ctx);
    return { ok: any, message: lines.join("\n") };
  },
  async poll() { return { data: null, metrics: {} }; }
};
