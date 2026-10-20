import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import { KEY } from "./mocks.js";
import { extractOutlets } from "../src/integrations/unifi.js";
import { networkRates } from "../src/integrations/zimaos.js";
import { findStorage } from "../src/integrations/unas.js";
import { TOKEN, mockProwlarr, mockSiteGateway, mockUnifi, selfSigned } from "./mocks2.js";

process.env.NODE_ENV = "test";
let ctx: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
let prowlarr: Awaited<ReturnType<typeof mockProwlarr>>, gateway: Awaited<ReturnType<typeof mockSiteGateway>>, unifi: Awaited<ReturnType<typeof mockUnifi>>, unifiTls: Awaited<ReturnType<typeof mockUnifi>>;

before(async () => {
  [prowlarr, gateway, unifi, unifiTls] = await Promise.all([mockProwlarr(), mockSiteGateway(), mockUnifi(), mockUnifi(selfSigned())]);
  ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "homebase-")), port: 0, host: "127.0.0.1", go2rtcUrl: "", webDir: "/nonexistent", trustProxy: false, startPollers: false });
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" }, headers: { "x-homebase": "1" } });
  cookie = (res.headers["set-cookie"] as string).split(";")[0];
});
after(async () => { await ctx.app.close(); await Promise.all([prowlarr.close(), gateway.close(), unifi.close(), unifiTls.close()]); });

const call = (method: string, url: string, payload?: unknown) => ctx.app.inject({ method: method as any, url, payload: payload as any, headers: { "x-homebase": "1", cookie } });
const create = async (body: object) => (await call("POST", "/api/integrations", body)).json().id as string;
const data = async (id: string) => { await ctx.poller.run(id); return (await call("GET", "/api/data")).json()[id]; };

test("new app types are offered", async () => {
  const ids = (await call("GET", "/api/integration-types")).json().map((t: any) => t.id);
  for (const id of ["prowlarr", "sitegateway", "unifi-network", "unifi-protect", "unifi-probe"]) assert.ok(ids.includes(id), id);
});

test("Prowlarr: test, poll, blocked indexers", async () => {
  assert.equal((await call("POST", "/api/integrations/test", { type: "prowlarr", url: prowlarr.url, apiKey: KEY })).json().ok, true);
  assert.equal((await call("POST", "/api/integrations/test", { type: "prowlarr", url: prowlarr.url, apiKey: "bad" })).json().ok, false);
  const id = await create({ type: "prowlarr", name: "Indexers", url: prowlarr.url, apiKey: KEY });
  const snap = await data(id);
  assert.equal(snap.ok, true);
  const d = snap.data;
  assert.deepEqual(d.indexers, { total: 3, enabled: 2, failing: 1 });
  assert.equal(d.failing[0].name, "1337x");
  assert.equal(d.totals.queries, 100); assert.equal(d.totals.grabs, 7); assert.equal(d.health.issues, 1);
  assert.equal(d.top[0].name, "NZBgeek");
  assert.equal(d.totals.failedGrabs, 2); assert.equal(d.totals.successPct, 99);
  assert.deepEqual(d.all.map((r: any) => [r.name, r.state]), [["1337x", "blocked"], ["NZBgeek", "ok"], ["Old", "disabled"]]);
  assert.equal(d.all[1].failPct, 1);
  assert.deepEqual(d.recent.map((r: any) => [r.indexer, r.kind, r.ok, r.what]), [["NZBgeek", "search", true, "Severance S02E01"], ["1337x", "search", false, "Andor"], ["NZBgeek", "grab", true, "Some.Release.1080p"]], "RSS and auth noise is left out");
  const run = await call("POST", `/api/integrations/${id}/actions/testall`, {});
  assert.equal(run.statusCode, 502); assert.match(run.json().error, /1 of 3 indexers failed/); assert.ok(!run.body.includes("secret-should-not-leak"), "per-indexer error text is not echoed");
  assert.ok(prowlarr.hits.includes("POST /api/v1/indexer/testall"));
});

test("Site Gateway: bearer token, attention items, single request per poll", async () => {
  assert.equal((await call("POST", "/api/integrations/test", { type: "sitegateway", url: gateway.url, apiKey: "wrong" })).json().ok, false);
  const good = (await call("POST", "/api/integrations/test", { type: "sitegateway", url: gateway.url, apiKey: TOKEN })).json();
  assert.equal(good.ok, true); assert.match(good.message, /0\.17\.7/);
  const id = await create({ type: "sitegateway", name: "Gateway", url: gateway.url, apiKey: TOKEN });
  await new Promise(r => setTimeout(r, 400)); // creating a connection starts its own first poll; let it finish before counting
  const before = gateway.hits.length;
  const d = (await data(id)).data;
  assert.equal(gateway.hits.length - before, 1, "bursts would trip Site Gateway's 10/min bearer limit");
  assert.equal(d.proxies.errors, 1); assert.equal(d.services.https, false); assert.equal(d.criticalCount, 1);
  assert.equal(d.certificates.within30Days, 1); assert.equal(d.liveRequests, 42); assert.equal(d.attention[0].kind, "https");
  assert.ok(!JSON.stringify(d).includes(TOKEN));
});

test("UniFi Network: clients, devices, gateway stats", async () => {
  assert.equal((await call("POST", "/api/integrations/test", { type: "unifi-network", url: unifi.url, apiKey: "bad" })).json().ok, false);
  const id = await create({ type: "unifi-network", name: "Network", url: unifi.url, apiKey: KEY });
  const d = (await data(id)).data;
  assert.equal(d.version, "9.1.120");
  assert.deepEqual(d.clients, { total: 3, wired: 1, wireless: 2 });
  assert.equal(d.devices.total, 4); assert.equal(d.devices.offline, 1); assert.equal(d.devices.problems[0].name, "Garage AP");
  assert.equal(d.gateway.name, "Dream Machine"); assert.equal(d.gateway.cpuPct, 12.5); assert.equal(d.gateway.rxBps, 9_000_000);
  assert.deepEqual(d.wans.map((w: any) => [w.name, w.up, w.rxBps, w.txBps]), [["Comcast", true, 8_000_000, 2_000_000], ["T-Mobile", false, 0, 0]], "each WAN with its own throughput");
  assert.deepEqual([d.speedtest.downMbps, d.speedtest.upMbps], [940.5, 880]);
  assert.equal(d.gateway.tempC, 61);
  assert.deepEqual(d.aps.map((a: any) => [a.name, a.clients]), [["Office AP", 2], ["Garage AP", 0]]);
  assert.deepEqual(d.wifi.map((w: any) => [w.name, w.enabled]), [["Home", true], ["Guest", false]]);
  assert.deepEqual(d.networks.map((n: any) => [n.name, n.vlan]), [["Default", 1], ["IoT", 30]]);
  assert.equal(d.deviceList.find((x: any) => x.name === "Office AP").updatable, true);
  assert.equal(d.pdus.length, 1, "the PDU tile can read PDUs from a plain UniFi Network connection");
  assert.deepEqual([d.pdus[0].name, d.pdus[0].totalW, d.pdus[0].outlets.length], ["Rack PDU", 60, 3]);
  assert.ok(unifi.hits.every(h => !h.includes(KEY)));
  const series = (await call("GET", `/api/metrics/${id}/clients?minutes=60`)).json();
  assert.equal(series[0][1], 3);
});

test("UniFi Network: WAN failover and health, field catalog, picked fields, live WAN rates", async () => {
  const id = await create({ type: "unifi-network", name: "Net2", url: unifi.url, apiKey: KEY });
  const d = (await data(id)).data;
  assert.deepEqual(d.wans.map((w: any) => [w.name, w.active, w.latencyMs, w.availabilityPct]), [["Comcast", true, 9, 99.9], ["T-Mobile", false, 48, 91.25]]);
  assert.equal(d.publicIp, "203.0.113.5");
  assert.deepEqual(d.custom, []);

  // The catalog lists what the console answered, never anything secret-looking.
  const cat = (await call("POST", "/api/integrations/catalog", { id })).json();
  const paths: string[] = cat.fields.map((f: any) => f.path);
  assert.ok(paths.some(p => /^devices\/[^/]+\/wan1\/rx_bytes-r$/.test(p)), "per-WAN rate is pickable");
  assert.ok(paths.includes("health/wan/wan_ip"));
  const dump = JSON.stringify(cat);
  for (const secret of ["SECRETKEY1", "SECRETPASS", "SECRETSSH", "SECRETID", "SECRETCLI", "SECRETPSK"]) assert.ok(!dump.includes(secret), secret);
  assert.ok(!paths.some(p => /authkey|passphrase|password|psk/i.test(p)), "secret-looking keys are not offered");
  assert.equal((await call("POST", "/api/integrations/catalog", { type: "prowlarr", url: prowlarr.url, apiKey: KEY })).statusCode, 400, "only apps with a catalog");

  // Save a selection, including one made-up path and a secret-looking path that must be dropped.
  const rx = paths.find(p => /\/wan1\/rx_bytes-r$/.test(p))!;
  const put = await call("PUT", `/api/integrations/${id}`, { type: "unifi-network", name: "Net2", url: unifi.url, apiKey: "", intervalSeconds: 15, fields: [
    { path: rx, label: "Fiber down", unit: "bytesps" }, { path: "health/wan/wan_ip", label: "", unit: "text" }, { path: "devices/aa/x_authkey", label: "bad", unit: "text" }, { path: "nope/x", label: "bad", unit: "text" }] });
  assert.equal(put.statusCode, 200);
  const saved = (await call("GET", "/api/integrations")).json().find((i: any) => i.id === id);
  assert.deepEqual(saved.fields.map((f: any) => f.path), [rx, "health/wan/wan_ip"]);
  const d2 = (await data(id)).data;
  assert.deepEqual(d2.custom.map((c: any) => [c.label, c.unit, c.value]), [["Fiber down", "bytesps", 1_000_000], ["Wan ip", "text", "203.0.113.5"]]);

  // Live sampler gives the per-WAN rates in bits per second.
  await call("GET", `/api/integrations/${id}/live?since=0`);
  await new Promise(r => setTimeout(r, 400));
  const live = (await call("GET", `/api/integrations/${id}/live?since=0`)).json();
  assert.equal(live.samples.at(-1).v.wan1_rx_bps, 8_000_000);
  assert.equal(live.samples.at(-1).v.wan2_tx_bps, 0);
  assert.deepEqual([live.samples.at(-1).v.cpu_pct, live.samples.at(-1).v.mem_pct, live.samples.at(-1).v.temp_c, live.samples.at(-1).v.wan1_up, live.samples.at(-1).v.wan2_up], [12.5, 48.7, 61, 1, 0], "CPU, RAM, temperature and link state are live too");

  // Catalog is admin-only.
  const anon = await ctx.app.inject({ method: "POST", url: "/api/integrations/catalog", payload: { id }, headers: { "x-homebase": "1" } });
  assert.equal(anon.statusCode, 401);
});

test("UniFi Protect: cameras connected and offline", async () => {
  const id = await create({ type: "unifi-protect", name: "Protect", url: unifi.url, apiKey: KEY });
  const d = (await data(id)).data;
  assert.deepEqual([d.cameras.total, d.cameras.connected, d.cameras.disconnected], [3, 2, 1]);
  assert.equal(d.cameras.problems[0].name, "Back"); assert.equal(d.others.sensors, 1); assert.equal(d.others.lights, null); assert.equal(d.nvr, "UNVR");
});

test("self-signed certificates are refused unless the connection allows them", async () => {
  const refused = (await call("POST", "/api/integrations/test", { type: "unifi-network", url: unifiTls.url, apiKey: KEY })).json();
  assert.equal(refused.ok, false); assert.match(refused.message, /Could not reach/);
  const allowed = (await call("POST", "/api/integrations/test", { type: "unifi-network", url: unifiTls.url, apiKey: KEY, insecureTls: true })).json();
  assert.equal(allowed.ok, true, allowed.message);
  const id = await create({ type: "unifi-network", name: "TLS", url: unifiTls.url, apiKey: KEY, insecureTls: true });
  assert.equal((await data(id)).ok, true);
  assert.equal((await call("GET", "/api/integrations")).json().find((i: any) => i.id === id).insecureTls, true);
});

test("UniFi probe lists answered paths, finds the PDU, and shows key names but no values", async () => {
  const res = (await call("POST", "/api/integrations/test", { type: "unifi-probe", url: unifi.url, apiKey: KEY })).json();
  assert.equal(res.ok, true);
  assert.match(res.message, /OK\s+\/proxy\/network\/integration\/v1\/info/);
  assert.match(res.message, /HTTP 404/);
  assert.match(res.message, /Found USP-PDU-Pro “Rack PDU”/);
  assert.match(res.message, /outletPowerW/);
  assert.ok(!res.message.includes("secretish") === false, "key names are listed");
  assert.ok(!res.message.includes("9.1.120"), "values are not echoed");
});

test("UniFi PDU: finds the PDU among Network devices and reads outlets and power", async () => {
  const done = (await call("POST", "/api/integrations/test", { type: "unifi-pdu", url: unifi.url, apiKey: KEY })).json();
  assert.equal(done.ok, true); assert.match(done.message, /found 1 PDU \(Rack PDU\)/);
  const id = await create({ type: "unifi-pdu", name: "PDU", url: unifi.url, apiKey: KEY });
  const d = (await data(id)).data;
  assert.equal(d.pdus.length, 1);
  const pdu = d.pdus[0];
  assert.equal(pdu.source, "classic"); assert.equal(pdu.totalW, 60); assert.equal(pdu.budgetW, 1440);
  assert.deepEqual(pdu.outlets.map((o: any) => [o.name, o.on, o.metered]), [["Switch", true, true], ["NAS", false, true], ["USB", true, false]]);
  assert.equal((await call("GET", `/api/metrics/${id}/power_w?minutes=60`)).json()[0][1], 60);
});

test("PDU outlets are also understood from Integration-API style fields", () => {
  const outlets = extractOutlets({ outlets: [{ outletIndex: 1, name: "A", state: "ON", powerW: 12.5 }, { outletIndex: 2, state: "OFF" }] });
  assert.deepEqual(outlets.map(o => [o.index, o.on, o.powerW]), [[1, true, 12.5], [2, false, null]]);
  assert.deepEqual(extractOutlets({ nothing: 1 }, null), []);
});

import { UNAS_PASS, UNAS_USER, ZIMA_PASS, ZIMA_USER, mockUnas, mockUnraid, mockZima } from "./mocks3.js";

test("Unraid: reads each section, tolerates a forbidden one, key stays in the header", async () => {
  const un = await mockUnraid();
  try {
    assert.equal((await call("POST", "/api/integrations/test", { type: "unraid", url: un.url, apiKey: "bad" })).json().ok, false);
    const t = (await call("POST", "/api/integrations/test", { type: "unraid", url: un.url, apiKey: KEY })).json();
    assert.equal(t.ok, true); assert.match(t.message, /tower/); assert.match(t.message, /Not available.*vms/);
    const id = await create({ type: "unraid", name: "Tower", url: un.url, apiKey: KEY });
    const d = (await data(id)).data;
    assert.equal(d.host.name, "tower"); assert.equal(d.cpuPct, 23.5); assert.equal(d.mem.pct, 37.5);
    assert.equal(d.array.state, "STARTED"); assert.equal(d.array.usedPct, 75); assert.equal(d.array.disks.length, 4);
    assert.equal(d.array.hottest, 52); assert.equal(d.array.diskProblems, 1); assert.equal(d.array.check.progress, 42);
    assert.deepEqual([d.docker.total, d.docker.running, d.docker.updates, d.docker.stopped[0]], [3, 2, 1, "old-thing"]);
    assert.equal(d.vms, null); assert.equal(d.notifications.warning, 1);
    assert.deepEqual(d.docker.list.map((c: any) => [c.name, c.running, c.update]), [["plex", true, true], ["sonarr", true, false], ["old-thing", false, false]]);
    assert.equal(d.docker.list[0].image, "plexinc/pms-docker");
    assert.deepEqual(d.shares.map((x: any) => [x.name, x.usedPct]), [["media", 75], ["appdata", 10]]);
    assert.deepEqual([d.array.lastCheck.status, d.array.lastCheck.errors, d.array.lastCheck.speed], ["OK", 2, "88 MB/s"], "the newest parity check wins");
    assert.ok(un.hits.every(h => !h.includes(KEY)));
    assert.equal((await call("GET", `/api/metrics/${id}/docker_running?minutes=60`)).json()[0][1], 2);
  } finally { await un.close(); }
});

test("Unraid: container and VM buttons send fixed mutations and refuse odd ids", async () => {
  const un = await mockUnraid({ vms: true });
  try {
    const id = await create({ type: "unraid", name: "Tower", url: un.url, apiKey: KEY });
    const d = (await data(id)).data;
    assert.deepEqual(d.vms.list.map((v: any) => [v.name, v.running]), [["Windows", true], ["Test", false]]);
    const act = (name: string, body: unknown) => call("POST", `/api/integrations/${id}/actions/${name}`, body);
    const before = un.queries.length;
    assert.equal((await act("containerstop", { id: "srv:abc123" })).statusCode, 200);
    assert.equal((await act("containerstart", { id: "srv:abc123" })).statusCode, 200);
    assert.equal((await act("vmreboot", { id: "v1" })).statusCode, 200);
    assert.deepEqual(un.queries.slice(before).filter(q => q.startsWith("mutation")), [
      'mutation { docker { stop(id: "srv:abc123") { id state } } }', 'mutation { docker { start(id: "srv:abc123") { id state } } }', 'mutation { vm { reboot(id: "v1") } }']);
    const mark = un.queries.filter(q => q.startsWith("mutation")).length;
    for (const bad of [{ id: 'x") { id } } mutation { docker { stop(id: "y' }, { id: "" }, { id: "a b" }, {}]) assert.equal((await act("containerstop", bad)).statusCode, 502, JSON.stringify(bad));
    assert.equal(un.queries.filter(q => q.startsWith("mutation")).length, mark, "refused ids never reach Unraid");
    const denied = await act("containerstart", { id: "denied" });
    assert.equal(denied.statusCode, 502); assert.match(denied.json().error, /Forbidden/);
    assert.equal((await act("containerrestart", { id: "srv:abc123" })).statusCode, 200);
  } finally { await un.close(); }
});

test("Unraid: an older release without newer fields still works through the fallback queries", async () => {
  const un = await mockUnraid({ legacy: true });
  try {
    const id = await create({ type: "unraid", name: "Old", url: un.url, apiKey: KEY });
    const d = (await data(id)).data;
    assert.equal(d.array.state, "STARTED"); assert.equal(d.array.totalKB, 4000); assert.equal(d.array.check, null);
  } finally { await un.close(); }
});

test("ZimaOS: logs in once, reuses the token, never leaks the password", async () => {
  const z = await mockZima();
  try {
    const bad = (await call("POST", "/api/integrations/test", { type: "zimaos", url: z.url, apiKey: `${ZIMA_USER}:wrongpass` })).json();
    assert.equal(bad.ok, false); assert.match(bad.message, /rejected that username or password/);
    assert.equal((await call("POST", "/api/integrations/test", { type: "zimaos", url: z.url, apiKey: "no-colon" })).json().ok, false);
    const t = (await call("POST", "/api/integrations/test", { type: "zimaos", url: z.url, apiKey: `${ZIMA_USER}:${ZIMA_PASS}` })).json();
    assert.equal(t.ok, true); assert.match(t.message, /1\.5\.3/);
    const id = await create({ type: "zimaos", name: "Zima", url: z.url, apiKey: `${ZIMA_USER}:${ZIMA_PASS}` });
    const loginsBefore = z.logins();
    const d = (await data(id)).data;
    await data(id);
    assert.equal(z.logins() - loginsBefore, 0, "token from the test is reused (login is limited to 5/min)");
    assert.equal(d.cpu.pct, 18.2); assert.equal(d.cpu.tempC, 51); assert.equal(d.mem.pct, 50); assert.equal(d.needUpdate, true);
    assert.equal(d.systemDisk.pct, 25); assert.equal(d.disks[0].name, "sda"); assert.deepEqual(d.apps, { total: 2, running: 1, known: true });
    assert.deepEqual(d.appList.map((a: any) => [a.name, a.running]), [["plex", true], ["Immich Photos", false]]);
    assert.deepEqual(d.containers.map((c: any) => [c.name, c.image, c.running]), [["plex", "plexinc/pms-docker", true], ["old", "x/y", false]]);
    assert.equal(d.vms, null, "no VM endpoint answered: reported as unavailable, not as zero VMs");
    assert.ok(!JSON.stringify([bad, t, d]).includes(ZIMA_PASS));
    const row = JSON.stringify((await call("GET", "/api/integrations")).json());
    assert.ok(!row.includes(ZIMA_PASS), "password never returned to the browser");
  } finally { await z.close(); }
});

test("ZimaOS network: rates come from counter deltas, virtual ports are skipped, resets are not negative", () => {
  const doc = (sent: number, recv: number) => ({ net: [{ name: "docker0", bytesSent: 9e9, bytesRecv: 9e9 }, { name: "eth0", bytesSent: sent, bytesRecv: recv }] });
  const first = networkRates("k", doc(1000, 2000), 1_000_000)!;
  assert.equal(first.iface, "eth0"); assert.equal(first.upBps, null, "no rate until there are two readings");
  const second = networkRates("k", doc(11_000, 7_000), 1_010_000)!;
  assert.deepEqual([second.upBps, second.downBps], [1000, 500]);
  const reset = networkRates("k", doc(5, 5), 1_020_000)!;
  assert.equal(reset.upBps, null, "a counter that went backwards (reboot) gives no rate instead of a negative one");
  assert.equal(networkRates("none", { net: [] }), null);
});

test("Live samples: sampling starts on request, returns rates, only for types that support it", async () => {
  const z = await mockZima();
  try {
    const id = await create({ type: "zimaos", name: "Zima live", url: z.url, apiKey: `${ZIMA_USER}:${ZIMA_PASS}` });
    const first = (await call("GET", `/api/integrations/${id}/live?since=0`)).json();
    assert.equal(first.intervalMs, 2000);
    await new Promise(r => setTimeout(r, 4600));
    const next = (await call("GET", `/api/integrations/${id}/live?since=0`)).json();
    assert.ok(next.samples.length >= 2, "samples were collected in the background");
    assert.equal(typeof next.samples.at(-1).v.up, "number", "after two readings there is a rate");
    const none = (await call("GET", `/api/integrations/${id}/live?since=${next.samples.at(-1).t}`)).json();
    assert.ok(none.samples.length <= 1, "since returns only newer samples");
    const nid = await create({ type: "unifi-protect", name: "No live", url: unifi.url, apiKey: KEY });
    assert.equal((await call("GET", `/api/integrations/${nid}/live`)).statusCode, 404);
  } finally { await z.close(); }
});

test("UNAS: signs in with a local account, sends the cookie, reads storage loosely, never leaks the password", async () => {
  const u = await mockUnas();
  try {
    const bad = (await call("POST", "/api/integrations/test", { type: "unifi-unas", url: u.url, apiKey: `${UNAS_USER}:wrong-pass` })).json();
    assert.equal(bad.ok, false); assert.ok(!JSON.stringify(bad).includes("wrong-pass"));
    assert.equal((await call("POST", "/api/integrations/test", { type: "unifi-unas", url: u.url, apiKey: "no-colon" })).json().ok, false);
    const t = (await call("POST", "/api/integrations/test", { type: "unifi-unas", url: u.url, apiKey: `${UNAS_USER}:${UNAS_PASS}` })).json();
    assert.equal(t.ok, true); assert.match(t.message, /\/proxy\/drive\/api\/v2\/storage: answers \(pools\)/); assert.match(t.message, /\/api\/system: answers \(name, version\)/);
    assert.ok(u.cookies.every(c => c.includes("TOKEN=jwt.abc")), "the session cookie is sent on every request");
    const id = await create({ type: "unifi-unas", name: "UNAS", url: u.url, apiKey: `${UNAS_USER}:${UNAS_PASS}` });
    const d = (await data(id)).data;
    assert.equal(d.name, "Garage UNAS");
    assert.deepEqual(d.storage, { totalB: 8e12, usedB: 2e12, availB: 6e12, status: "healthy" });
    assert.ok(!JSON.stringify([bad, t, d]).includes(UNAS_PASS));
  } finally { await u.close(); }
});

test("UNAS storage reader: shallowest match, derives missing numbers, rejects junk", () => {
  assert.deepEqual(findStorage({ size: 100, used: 40 }), { totalB: 100, usedB: 40, availB: 60, status: null });
  assert.deepEqual(findStorage({ used: 30, free: 70, state: "OK" }), { totalB: 100, usedB: 30, availB: 70, status: "OK" });
  assert.equal(findStorage({ drives: [{ size: 5 }] }), null, "a lone drive size with no used figure is not a storage reading");
  assert.equal(findStorage({ name: "x" }), null);
});

test("UniFi Network: load-balanced WAN links all count as active, failover keeps one", async () => {
  const { nameWans } = await import("../src/integrations/unifi.js");
  const links = [{ name: "eth8", ifname: "", group: "WAN", up: true, active: true }, { name: "eth0", ifname: "", group: "WAN2", up: true, active: false }, { name: "eth1", ifname: "", group: "WAN3", up: false, active: false }] as any[];
  const balanced = nameWans(links, [1, 2, 3].map(n => ({ purpose: "wan", name: `ISP ${n}`, wan_networkgroup: n === 1 ? "WAN" : `WAN${n}`, wan_load_balance_type: "weighted" })));
  assert.deepEqual(balanced.map(w => [w.name, w.active, w.balanced]), [["ISP 1", true, true], ["ISP 2", true, true], ["ISP 3", false, true]]);
  const failover = nameWans(links, [1, 2, 3].map(n => ({ purpose: "wan", name: `ISP ${n}`, wan_networkgroup: n === 1 ? "WAN" : `WAN${n}`, wan_load_balance_type: "failover-only" })));
  assert.deepEqual(failover.map(w => [w.active, w.balanced]), [[true, undefined], [false, undefined], [false, undefined]]);
});
