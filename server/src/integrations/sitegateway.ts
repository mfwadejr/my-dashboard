import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

/** Site Gateway API tokens are sent as `Authorization: Bearer`. One request per poll: it limits bearer calls to 10 a minute. */
const get = (ctx: Ctx, path: string) => getJson(ctx, path, { headers: { Authorization: `Bearer ${ctx.apiKey}` } });
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const counts = (o: any) => ({ total: num(o?.total), running: num(o?.running), disabled: num(o?.disabled), errors: num(o?.errors) });

async function test(ctx: Ctx): Promise<TestResult> {
  const d = await get(ctx, "/api/dashboard");
  if (!d || typeof d !== "object" || !d.gateway || !d.services) throw new IntegrationError("That address answered, but it does not look like Site Gateway");
  const version = d.system?.appVersion;
  return { ok: true, message: `Connected to Site Gateway${version ? " " + version : ""}`, version };
}

async function poll(ctx: Ctx): Promise<PollResult> {
  const d = await get(ctx, "/api/dashboard");
  if (!d?.gateway) throw new IntegrationError("Unexpected answer from Site Gateway");
  const attention = ((d.attention ?? []) as any[]).map(a => ({ name: String(a.name ?? ""), message: String(a.message ?? ""), severity: a.severity === "critical" ? "critical" : "warning" }));
  const certs = d.certificates ?? {};
  const data = {
    version: d.system?.appVersion ?? null,
    gateway: { status: String(d.gateway.status ?? ""), healthy: Boolean(d.gateway.healthy) },
    services: {
      http: Boolean(d.services?.http?.healthy), https: Boolean(d.services?.https?.healthy), httpsConfigured: d.services?.https?.status !== "unconfigured",
      storage: Boolean(d.services?.storage?.healthy)
    },
    hosted: counts(d.hosted), proxies: counts(d.proxies),
    upstreams: { total: num(d.upstreams?.total), healthy: num(d.upstreams?.healthy), unhealthy: num(d.upstreams?.unhealthy) },
    certificates: { total: num(certs.total), healthy: num(certs.healthy), within30Days: num(certs.within30Days), within7Days: num(certs.within7Days) },
    streams: { total: num(d.streamingPorts?.total), listening: num(d.streamingPorts?.listening) },
    liveRequests: num(d.throughput?.liveRequests),
    publicIp: d.system?.publicIp ? String(d.system.publicIp) : null,
    attention: attention.slice(0, 6), attentionCount: attention.length,
    criticalCount: attention.filter(a => a.severity === "critical").length
  };
  return { data, metrics: { attention: data.attentionCount, critical: data.criticalCount, live_requests: data.liveRequests, upstreams_unhealthy: data.upstreams.unhealthy, proxy_errors: data.proxies.errors } };
}

export const siteGateway: IntegrationType = {
  id: "sitegateway", name: "Site Gateway",
  description: "Gateway, HTTP/HTTPS and storage health, hosted sites, proxies, certificates, items needing attention",
  urlHint: "http://192.168.1.10:8080",
  keyLabel: "API token (Site Gateway → Account → API tokens, read-only is enough)",
  test, poll
};
