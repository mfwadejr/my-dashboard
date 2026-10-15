import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

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

async function networkPoll(ctx: Ctx): Promise<PollResult> {
  const info = await hinted("UniFi Network", () => get(ctx, `${NET}/info`));
  const sites = items(await get(ctx, `${NET}/sites`, { limit: 200 }));
  const site = sites.find(s => s?.internalReference === "default") ?? sites[0];
  if (!site?.id) throw new IntegrationError("UniFi Network returned no sites");
  const [devicesDoc, clientsDoc] = await Promise.allSettled([
    get(ctx, `${NET}/sites/${site.id}/devices`, { limit: 200 }),
    get(ctx, `${NET}/sites/${site.id}/clients`, { limit: 200 })
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
  if (gw?.id) {
    const stats = await get(ctx, `${NET}/sites/${site.id}/devices/${gw.id}/statistics/latest`).catch(() => null);
    const up = stats?.uplink ?? {};
    gateway = {
      name: String(gw.name ?? gw.model ?? "Gateway"), model: String(gw.model ?? ""),
      cpuPct: stats?.cpuUtilizationPct ?? null, memPct: stats?.memoryUtilizationPct ?? null, uptimeSec: stats?.uptimeSec ?? null,
      txBps: up.txRateBps ?? null, rxBps: up.rxRateBps ?? null
    };
  }
  // PDUs are Network devices, so the PDU tile can read them from this same connection.
  const pdus = devicesDoc.status === "fulfilled" ? await readPdus(ctx, site, devices).catch(() => []) : [];
  const data = {
    version: info?.applicationVersion ?? null,
    pdus,
    site: { id: String(site.id), name: String(site.name ?? "Default") },
    devices: devicesDoc.status === "fulfilled" ? { total: devices.length, online: devices.length - problem.length, offline: problem.length, problems: problem.slice(0, 6).map(d => ({ name: String(d.name ?? d.model ?? "Device"), model: String(d.model ?? ""), state: String(d.state) })) } : null,
    clients: totalClients === null ? null : { total: totalClients, wired: exact ? clients.filter(c => typeOf(c) === "WIRED").length : null, wireless: exact ? clients.filter(c => typeOf(c) === "WIRELESS").length : null },
    gateway
  };
  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(pduMetrics(pdus))) metrics[`pdu_${k}`] = v;
  if (data.clients) metrics.clients = data.clients.total;
  if (data.devices) { metrics.devices_total = data.devices.total; metrics.devices_offline = data.devices.offline; }
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

// ---------------------------------------------------------------- PDU (a Network device)

const PDU_MODEL = /pdu/i;
const truthy = (v: unknown): boolean | null => (typeof v === "boolean" ? v : typeof v === "string" ? ["on", "true", "1", "enabled"].includes(v.toLowerCase()) : typeof v === "number" ? v !== 0 : null);
const firstNum = (...vals: unknown[]): number | null => { for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v; return null; };

export interface Outlet { index: number; name: string; on: boolean | null; powerW: number | null; currentA: number | null; voltageV: number | null; metered: boolean }

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
      const powerW = firstNum(o.outlet_power, o.power, o.powerW, o.powerWatts, o.outletPowerW);
      return {
        index: firstNum(o.index, o.outletIndex, o.id) ?? i + 1,
        name: String(o.name ?? o.label ?? `Outlet ${i + 1}`),
        on: truthy(o.relay_state ?? o.relayState ?? o.state ?? o.on ?? o.isOn ?? o.enabled),
        powerW, currentA: firstNum(o.outlet_current, o.current, o.currentA), voltageV: firstNum(o.outlet_voltage, o.voltage, o.voltageV),
        metered: caps !== null ? caps === 3 : powerW !== null
      };
    });
  }
  return [];
}

function totalWatts(...docs: any[]): number | null {
  for (const doc of docs) {
    if (!doc || typeof doc !== "object") continue;
    const v = firstNum(doc.outlet_ac_power_consumption, doc.powerConsumptionW, doc.totalPowerW, doc.acPowerConsumptionW);
    if (v !== null) return v;
  }
  return null;
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
      source: classic?.outlet_table ? "classic" : outlets.length ? "integration" : "none", outlets
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
  test: networkTest, poll: networkPoll
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
