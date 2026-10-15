import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

/**
 * Unraid's official API is GraphQL at /graphql with the key in x-api-key. Field names differ a little between Unraid versions,
 * so each section is its own query with a smaller fallback, and a section that fails is left out instead of failing the tile.
 */
async function gql(ctx: Ctx, query: string): Promise<any> {
  const doc = await getJson(ctx, "/graphql", { headers: { "x-api-key": ctx.apiKey }, body: { query } });
  if (doc?.errors?.length && !doc.data) throw new IntegrationError(String(doc.errors[0]?.message ?? "GraphQL error"));
  if (!doc || typeof doc !== "object" || !doc.data) throw new IntegrationError("That address answered, but it does not look like the Unraid API");
  return doc.data;
}

async function firstOf(ctx: Ctx, queries: string[]): Promise<any> {
  let last: unknown;
  for (const q of queries) {
    try { return await gql(ctx, q); } catch (e) { last = e; if (e instanceof IntegrationError && e.status) throw e; }
  }
  throw last;
}

const num = (v: unknown): number | null => { const n = Number(v); return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? n : null; };

const Q = {
  info: ["{ info { os { hostname uptime } cpu { brand cores threads } } }", "{ info { os { uptime } cpu { brand cores threads } } }"],
  metrics: ["{ metrics { cpu { percentTotal } memory { total used percentTotal } } }"],
  array: [
    "{ array { state capacity { kilobytes { free used total } } parities { name status temp } disks { name status temp size fsSize fsFree fsUsed isSpinning numErrors } caches { name status temp fsSize fsFree fsUsed } parityCheckStatus { status progress running paused errors } } }",
    "{ array { state capacity { kilobytes { free used total } } disks { name status temp size fsSize fsFree fsUsed } caches { name status temp fsSize fsFree fsUsed } } }",
    "{ array { state capacity { disks { free used total } } disks { name size status temp } } }"
  ],
  docker: ["{ docker { containers { id names state status autoStart isUpdateAvailable } } }", "{ dockerContainers { id names state status autoStart } }"],
  vms: ["{ vms { domains { id name state } } }"],
  notifications: ["{ notifications { overview { unread { info warning alert total } } } }"]
} as const;

type Section = keyof typeof Q;
const SECTIONS = Object.keys(Q) as Section[];

async function readSections(ctx: Ctx): Promise<{ data: Partial<Record<Section, any>>; failed: Partial<Record<Section, string>> }> {
  const results = await Promise.allSettled(SECTIONS.map(s => firstOf(ctx, [...Q[s]])));
  const data: Partial<Record<Section, any>> = {}, failed: Partial<Record<Section, string>> = {};
  results.forEach((r, i) => { if (r.status === "fulfilled") data[SECTIONS[i]] = r.value; else failed[SECTIONS[i]] = r.reason instanceof Error ? r.reason.message : "failed"; });
  return { data, failed };
}

const diskRow = (d: any, kind: string) => {
  const size = num(d.fsSize), used = num(d.fsUsed), free = num(d.fsFree);
  const total = size ?? (used !== null && free !== null ? used + free : null);
  return {
    name: String(d.name ?? kind), kind, status: String(d.status ?? ""), tempC: num(d.temp), spinning: typeof d.isSpinning === "boolean" ? d.isSpinning : null,
    usedPct: total && used !== null ? Math.round((used / total) * 100) : null, errors: num(d.numErrors) ?? 0
  };
};

function shape(sections: Partial<Record<Section, any>>) {
  const info = sections.info?.info, m = sections.metrics?.metrics, a = sections.array?.array;
  const containers = (sections.docker?.docker?.containers ?? sections.docker?.dockerContainers ?? []) as any[];
  const domains = (sections.vms?.vms?.domains ?? []) as any[];
  const unread = sections.notifications?.notifications?.overview?.unread;
  const kb = a?.capacity?.kilobytes ?? null;
  const legacy = a?.capacity?.disks ?? null;
  const total = num(kb?.total ?? legacy?.total), used = num(kb?.used ?? legacy?.used), free = num(kb?.free ?? legacy?.free);
  const disks = a ? [...(a.parities ?? []).map((d: any) => diskRow(d, "parity")), ...(a.disks ?? []).map((d: any) => diskRow(d, "data")), ...(a.caches ?? []).map((d: any) => diskRow(d, "cache"))] : [];
  const check = a?.parityCheckStatus;
  const running = (c: any) => String(c.state ?? "").toUpperCase() === "RUNNING";
  const data = {
    host: info ? { name: info.os?.hostname ?? null, uptimeSec: info.os?.uptime ? Math.max(0, Math.round((Date.now() - new Date(info.os.uptime).getTime()) / 1000)) || null : null, cpu: info.cpu?.brand ?? null, cores: num(info.cpu?.cores), threads: num(info.cpu?.threads) } : null,
    cpuPct: num(m?.cpu?.percentTotal), mem: m?.memory ? { totalB: num(m.memory.total), usedB: num(m.memory.used), pct: num(m.memory.percentTotal) } : null,
    array: a ? {
      state: String(a.state ?? ""), totalKB: total, usedKB: used, freeKB: free, usedPct: total && used !== null ? Math.round((used / total) * 100) : null,
      disks, hottest: disks.reduce((mx: number, d: any) => (d.tempC !== null && d.tempC > mx ? d.tempC : mx), 0) || null,
      diskProblems: disks.filter((d: any) => d.errors > 0 || /DSBL|INVALID|MISSING|NP_DSBL|DISABLED/i.test(d.status)).length,
      check: check ? { running: Boolean(check.running), paused: Boolean(check.paused), progress: num(check.progress), errors: num(check.errors) ?? 0, status: String(check.status ?? "") } : null
    } : null,
    docker: sections.docker ? { total: containers.length, running: containers.filter(running).length, updates: containers.filter(c => c.isUpdateAvailable === true).length, stopped: containers.filter(c => !running(c)).slice(0, 8).map(c => String((c.names?.[0] ?? c.id ?? "").toString().replace(/^\//, ""))) } : null,
    vms: sections.vms ? { total: domains.length, running: domains.filter(d => String(d.state ?? "").toUpperCase() === "RUNNING").length } : null,
    notifications: unread ? { info: num(unread.info) ?? 0, warning: num(unread.warning) ?? 0, alert: num(unread.alert) ?? 0 } : null
  };
  return data;
}

async function test(ctx: Ctx): Promise<TestResult> {
  const { data, failed } = await readSections(ctx);
  const ok = SECTIONS.filter(s => data[s]);
  if (ok.length === 0) throw new IntegrationError(Object.values(failed)[0] ?? "Could not read anything from Unraid");
  const host = data.info?.info?.os?.hostname;
  const missing = SECTIONS.filter(s => !data[s]);
  return { ok: true, message: `Connected to Unraid${host ? " " + host : ""}\nReadable: ${ok.join(", ")}${missing.length ? `\nNot available with this key or version: ${missing.join(", ")}` : ""}` };
}

async function poll(ctx: Ctx): Promise<PollResult> {
  const { data: sections } = await readSections(ctx);
  if (!Object.keys(sections).length) throw new IntegrationError("Unraid did not answer any query");
  const data = shape(sections);
  const metrics: Record<string, number> = {};
  const put = (k: string, v: number | null | undefined) => { if (typeof v === "number" && Number.isFinite(v)) metrics[k] = v; };
  put("cpu_pct", data.cpuPct); put("mem_pct", data.mem?.pct); put("array_used_pct", data.array?.usedPct); put("hottest_c", data.array?.hottest);
  put("docker_running", data.docker?.running); put("docker_total", data.docker?.total); put("alerts", data.notifications?.alert); put("warnings", data.notifications?.warning);
  return { data, metrics };
}

export const unraid: IntegrationType = {
  id: "unraid", name: "Unraid",
  description: "Array state and capacity, disk temperatures, CPU and memory, Docker containers, VMs, notifications",
  urlHint: "http://192.168.1.10  (https:// if your server uses SSL)",
  keyLabel: "API key (Unraid → Settings → Management Access → API Keys)",
  test, poll
};
