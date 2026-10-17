import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

const get = (ctx: Ctx, path: string, query?: Record<string, string | number | boolean>) => getJson(ctx, path, { headers: { "X-Api-Key": ctx.apiKey }, query });

/** History event types arrive as words in current Prowlarr and as numbers in some older builds. */
const EVENTS: Record<string, string> = { "1": "grab", releasegrabbed: "grab", "2": "search", indexerquery: "search", "3": "rss", indexerrss: "rss", "4": "auth", indexerauth: "auth" };
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function test(ctx: Ctx): Promise<TestResult> {
  const status = await get(ctx, "/api/v1/system/status");
  const name = String(status?.appName ?? status?.instanceName ?? "");
  if (name && !name.toLowerCase().includes("prowlarr") && /sonarr|radarr|lidarr|readarr/i.test(name)) return { ok: false, message: `This address is ${name}, not Prowlarr` };
  return { ok: true, message: `Connected to ${name || "Prowlarr"}${status?.version ? " " + status.version : ""}`, version: status?.version };
}

async function poll(ctx: Ctx): Promise<PollResult> {
  const status = await get(ctx, "/api/v1/system/status");
  const [indexers, indexerStatus, stats, health, history] = await Promise.allSettled([
    get(ctx, "/api/v1/indexer"), get(ctx, "/api/v1/indexerstatus"), get(ctx, "/api/v1/indexerstats"), get(ctx, "/api/v1/health"),
    get(ctx, "/api/v1/history", { page: 1, pageSize: 30, sortKey: "date", sortDirection: "descending" })
  ]);
  const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

  const list = (ok(indexers) ?? []) as any[];
  const blocked = new Map<number, string>();
  const lastFailure = new Map<number, string>();
  for (const s of (ok(indexerStatus) ?? []) as any[]) {
    if (s?.disabledTill && new Date(s.disabledTill).getTime() > Date.now()) blocked.set(Number(s.indexerId), String(s.disabledTill));
    if (s?.mostRecentFailure) lastFailure.set(Number(s.indexerId), String(s.mostRecentFailure));
  }
  const perIndexer = new Map<number, any>();
  for (const s of (ok(stats)?.indexers ?? []) as any[]) perIndexer.set(Number(s.indexerId), s);

  const rows = list.map(i => {
    const st = perIndexer.get(Number(i.id));
    const queries = num(st?.numberOfQueries) + num(st?.numberOfRssQueries) + num(st?.numberOfAuthQueries);
    return {
      id: Number(i.id), name: String(i.name ?? "Indexer"), enabled: Boolean(i.enable), protocol: String(i.protocol ?? ""),
      blockedUntil: blocked.get(Number(i.id)) ?? null,
      queries, grabs: num(st?.numberOfGrabs), failed: num(st?.numberOfFailedQueries), failedGrabs: num(st?.numberOfFailedGrabs), avgMs: st ? num(st.averageResponseTime) : null,
      priority: i.priority === undefined ? null : num(i.priority), privacy: i.privacy ? String(i.privacy) : null, lastFailure: lastFailure.get(Number(i.id)) ?? null
    };
  });
  const enabled = rows.filter(r => r.enabled);
  const failing = enabled.filter(r => r.blockedUntil);
  const issues = ((ok(health) ?? []) as any[]).filter(h => h.type === "warning" || h.type === "error");
  const names = new Map(rows.map(r => [r.id, r.name]));
  const recent = ((ok(history)?.records ?? []) as any[]).map(r => {
    const d = r.data ?? {};
    return {
      indexer: names.get(Number(r.indexerId)) ?? "Indexer", kind: EVENTS[String(r.eventType).toLowerCase()] ?? "other", ok: r.successful !== false,
      what: String(d.query ?? d.title ?? d.queryType ?? "").slice(0, 120), source: d.source ? String(d.source).slice(0, 40) : null, date: r.date ?? null
    };
  }).filter(r => r.kind !== "rss" && r.kind !== "auth").slice(0, 12);
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const totalQueries = sum(r => r.queries), totalFailed = sum(r => r.failed);
  const data = {
    version: status?.version ?? null,
    indexers: { total: rows.length, enabled: enabled.length, failing: failing.length },
    totals: {
      queries: totalQueries, grabs: sum(r => r.grabs), failed: totalFailed, failedGrabs: sum(r => r.failedGrabs),
      successPct: totalQueries > 0 ? Math.max(0, Math.round((1 - totalFailed / totalQueries) * 1000) / 10) : null
    },
    all: rows.map(r => ({ ...r, state: !r.enabled ? "disabled" : r.blockedUntil ? "blocked" : "ok", failPct: r.queries > 0 ? Math.round((r.failed / r.queries) * 1000) / 10 : null }))
      .sort((a, b) => ["blocked", "ok", "disabled"].indexOf(a.state) - ["blocked", "ok", "disabled"].indexOf(b.state) || a.name.localeCompare(b.name)).slice(0, 60),
    recent,
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
  test, poll,
  actions: {
    /** Runs Prowlarr's own "test all indexers". Slow (each indexer is contacted), so it gets a long timeout. */
    testall: async ctx => {
      const out = await getJson(ctx, "/api/v1/indexer/testall", { headers: { "X-Api-Key": ctx.apiKey }, body: {}, timeoutMs: 90_000 }).catch(e => {
        // Some versions answer 400 with the failing indexers listed; either way report the failures.
        throw e instanceof IntegrationError ? new IntegrationError(`Some indexers failed their test${e.message ? `: ${e.message}` : ""}`.slice(0, 240)) : e;
      });
      const results = Array.isArray(out) ? out : [];
      const bad = results.filter((r: any) => r?.isValid === false);
      if (bad.length) throw new IntegrationError(`${bad.length} of ${results.length} indexers failed their test`);
      return { message: `All ${results.length} indexers passed their test` };
    }
  }
};
export { IntegrationError };
