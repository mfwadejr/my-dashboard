import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

const get = (ctx: Ctx, path: string) => getJson(ctx, path, { headers: { "X-Api-Key": ctx.apiKey } });
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function test(ctx: Ctx): Promise<TestResult> {
  const status = await get(ctx, "/api/v1/system/status");
  const name = String(status?.appName ?? status?.instanceName ?? "");
  if (name && !name.toLowerCase().includes("prowlarr") && /sonarr|radarr|lidarr|readarr/i.test(name)) return { ok: false, message: `This address is ${name}, not Prowlarr` };
  return { ok: true, message: `Connected to ${name || "Prowlarr"}${status?.version ? " " + status.version : ""}`, version: status?.version };
}

async function poll(ctx: Ctx): Promise<PollResult> {
  const status = await get(ctx, "/api/v1/system/status");
  const [indexers, indexerStatus, stats, health] = await Promise.allSettled([
    get(ctx, "/api/v1/indexer"), get(ctx, "/api/v1/indexerstatus"), get(ctx, "/api/v1/indexerstats"), get(ctx, "/api/v1/health")
  ]);
  const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

  const list = (ok(indexers) ?? []) as any[];
  const blocked = new Map<number, string>();
  for (const s of (ok(indexerStatus) ?? []) as any[]) {
    if (s?.disabledTill && new Date(s.disabledTill).getTime() > Date.now()) blocked.set(Number(s.indexerId), String(s.disabledTill));
  }
  const perIndexer = new Map<number, any>();
  for (const s of (ok(stats)?.indexers ?? []) as any[]) perIndexer.set(Number(s.indexerId), s);

  const rows = list.map(i => {
    const st = perIndexer.get(Number(i.id));
    const queries = num(st?.numberOfQueries) + num(st?.numberOfRssQueries) + num(st?.numberOfAuthQueries);
    return {
      id: Number(i.id), name: String(i.name ?? "Indexer"), enabled: Boolean(i.enable), protocol: String(i.protocol ?? ""),
      blockedUntil: blocked.get(Number(i.id)) ?? null,
      queries, grabs: num(st?.numberOfGrabs), failed: num(st?.numberOfFailedQueries), avgMs: st ? num(st.averageResponseTime) : null
    };
  });
  const enabled = rows.filter(r => r.enabled);
  const failing = enabled.filter(r => r.blockedUntil);
  const issues = ((ok(health) ?? []) as any[]).filter(h => h.type === "warning" || h.type === "error");
  const data = {
    version: status?.version ?? null,
    indexers: { total: rows.length, enabled: enabled.length, failing: failing.length },
    totals: { queries: rows.reduce((a, r) => a + r.queries, 0), grabs: rows.reduce((a, r) => a + r.grabs, 0), failed: rows.reduce((a, r) => a + r.failed, 0) },
    top: enabled.filter(r => !r.blockedUntil).sort((a, b) => b.queries - a.queries).slice(0, 6),
    failing: failing.slice(0, 6).map(r => ({ name: r.name, blockedUntil: r.blockedUntil })),
    health: { issues: issues.length, messages: issues.slice(0, 5).map(h => String(h.message ?? h.source ?? "")) }
  };
  return { data, metrics: { indexers_enabled: data.indexers.enabled, indexers_failing: data.indexers.failing, queries: data.totals.queries, grabs: data.totals.grabs, health_issues: data.health.issues } };
}

export const prowlarr: IntegrationType = {
  id: "prowlarr", name: "Prowlarr",
  description: "Indexer health, blocked indexers, queries and grabs",
  urlHint: "http://192.168.1.10:9696",
  keyLabel: "Prowlarr API key (Settings → General)",
  test, poll
};
export { IntegrationError };
