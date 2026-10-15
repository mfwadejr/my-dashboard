import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY, start, type Mock } from "./mocks.js";

export const TOKEN = "sg-token-abc";

export function mockProwlarr(): Promise<Mock> {
  return start((req, url) => {
    if (req.headers["x-api-key"] !== KEY) return { status: 401, body: {} };
    switch (url.pathname) {
      case "/api/v1/system/status": return { body: { appName: "Prowlarr", version: "1.30.2" } };
      case "/api/v1/indexer": return { body: [
        { id: 1, name: "NZBgeek", enable: true, protocol: "usenet" }, { id: 2, name: "1337x", enable: true, protocol: "torrent" }, { id: 3, name: "Old", enable: false, protocol: "torrent" }] };
      case "/api/v1/indexerstatus": return { body: [{ indexerId: 2, disabledTill: new Date(Date.now() + 3600_000).toISOString() }] };
      case "/api/v1/indexerstats": return { body: { indexers: [{ indexerId: 1, indexerName: "NZBgeek", averageResponseTime: 420, numberOfQueries: 90, numberOfGrabs: 7, numberOfRssQueries: 10, numberOfAuthQueries: 0, numberOfFailedQueries: 1 }] } };
      case "/api/v1/health": return { body: [{ type: "warning", source: "IndexerStatusCheck", message: "Indexers unavailable due to failures: 1337x" }] };
      default: return { status: 404 };
    }
  });
}

export function mockSiteGateway(): Promise<Mock> {
  return start((req, url) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { error: "That API token is not valid" } };
    if (url.pathname !== "/api/dashboard") return { status: 404 };
    return { body: {
      gateway: { status: "ready", healthy: true }, services: { http: { healthy: true }, https: { healthy: false, status: "error" }, storage: { healthy: true } },
      hosted: { total: 3, running: 3, disabled: 0, errors: 0 }, proxies: { total: 5, running: 4, disabled: 0, errors: 1 },
      upstreams: { total: 5, healthy: 4, unhealthy: 1 }, certificates: { total: 4, healthy: 3, within30Days: 1, within7Days: 0 },
      streamingPorts: { total: 1, listening: 1 }, throughput: { liveRequests: 42 },
      attention: [{ kind: "https", name: "HTTPS · Port 443", message: "TLS domains are enabled but port 443 is not accepting connections.", severity: "critical" }],
      system: { appVersion: "0.17.7", publicIp: "203.0.113.9" }
    } };
  });
}

/** Self-signed certificate, like a real UniFi console. */
export function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "hb-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=unifi.local"], { stdio: "ignore" });
  return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
}

const SITE = "11111111-1111-1111-1111-111111111111";
export function mockUnifi(tls?: { key: string; cert: string }): Promise<Mock> {
  return start((req, url) => {
    if (req.headers["x-api-key"] !== KEY) return { status: 401, body: { code: "api.authentication.missing-credentials" } };
    const p = url.pathname;
    if (p === "/proxy/network/integration/v1/info") return { body: { applicationVersion: "9.1.120" } };
    if (p === "/proxy/network/integration/v1/sites") return { body: { offset: 0, limit: 200, count: 1, totalCount: 1, data: [{ id: SITE, internalReference: "default", name: "Default" }] } };
    if (p === `/proxy/network/integration/v1/sites/${SITE}/devices`) return { body: { offset: 0, limit: 200, count: 4, totalCount: 4, data: [
      { id: "d1", name: "Dream Machine", model: "UDM-Pro", type: "UDM", state: "ONLINE" },
      { id: "d2", name: "Office AP", model: "U7-Pro", type: "UAP", state: "ONLINE" },
      { id: "d3", name: "Garage AP", model: "U6-LR", type: "UAP", state: "OFFLINE" },
      { id: "d4", macAddress: "aa:bb:cc:00:00:04", name: "Rack PDU", model: "USP-PDU-Pro", type: "USP", state: "ONLINE" }] } };
    if (p === `/proxy/network/integration/v1/sites/${SITE}/devices/d1/statistics/latest`) return { body: { uptimeSec: 86400, cpuUtilizationPct: 12.5, memoryUtilizationPct: 48, uplink: { txRateBps: 2_000_000, rxRateBps: 9_000_000 } } };
    if (p === `/proxy/network/integration/v1/sites/${SITE}/devices/d4/statistics/latest`) return { body: { uptimeSec: 5, outletPowerW: 1 } };
    if (p === `/proxy/network/integration/v1/sites/${SITE}/devices/d4`) return { body: { id: "d4", name: "Rack PDU", model: "USP-PDU-Pro", state: "ONLINE", secretish: "x" } };
    if (p === `/proxy/network/integration/v1/sites/${SITE}/clients`) return { body: { offset: 0, limit: 200, count: 3, totalCount: 3, data: [{ type: "WIRED" }, { type: "WIRELESS" }, { type: "WIRELESS" }] } };
    if (p === "/proxy/network/api/s/default/stat/device/aa%3Abb%3Acc%3A00%3A00%3A04" || p === "/proxy/network/api/s/default/stat/device/aa:bb:cc:00:00:04") return { body: { meta: { rc: "ok" }, data: [{
      outlet_ac_power_consumption: 60, outlet_ac_power_budget: 1440,
      outlet_table: [{ index: 1, name: "Switch", relay_state: true, outlet_caps: 3, outlet_current: 0.5, outlet_power: 60, outlet_voltage: 120 }, { index: 2, name: "NAS", relay_state: false, outlet_caps: 3, outlet_power: 0 }, { index: 3, name: "USB", relay_state: true, outlet_caps: 1 }] }] } };
    if (p === "/proxy/protect/integration/v1/meta/info") return { body: { applicationVersion: "6.1.78" } };
    if (p === "/proxy/protect/integration/v1/cameras") return { body: [{ id: "c1", name: "Front", state: "CONNECTED" }, { id: "c2", name: "Back", state: "DISCONNECTED" }, { id: "c3", name: "Drive", state: "CONNECTED" }] };
    if (p === "/proxy/protect/integration/v1/sensors") return { body: [{ id: "s1" }] };
    if (p === "/proxy/protect/integration/v1/nvrs") return { body: { id: "n1", name: "UNVR" } };
    return { status: 404 };
  }, tls);
}
