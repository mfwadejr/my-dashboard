import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as httpServer, type Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createServer as tcpServer, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import { selfSigned } from "./mocks2.js";

process.env.NODE_ENV = "test";
const H = { "x-homebase": "1" };
type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx, admin = "", viewer = "";
let web: Server, secure: Server, tcp: TcpServer, webUrl = "", secureUrl = "", tcpPort = 0;
let mode = { status: 200, body: "<h1>Hello world</h1>", delay: 0 };

const cookieOf = (res: { headers: Record<string, any> }) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).map(c => c.split(";")[0])[0] ?? "";
const raw = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => ctx.app.inject({ method: method as any, url, payload: payload as any, headers });
const call = (method: string, url: string, payload?: unknown, cookie = admin) => raw(method, url, payload, { ...H, ...(cookie ? { cookie } : {}) });
const listen = (s: Server | TcpServer) => new Promise<number>(r => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const closedPort = async () => { const s = tcpServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; };
const view = async (id: string, cookie = admin) => ((await call("GET", "/api/monitors", undefined, cookie)).json().items as any[]).find(m => m.id === id);

before(async () => {
  web = httpServer((req, res) => {
    const send = () => { res.writeHead(mode.status, { "content-type": "text/html" }); res.end(req.method === "HEAD" ? undefined : mode.body); };
    if (req.url === "/redirect") { res.writeHead(302, { location: "/" }); return res.end(); }
    if (mode.delay) setTimeout(send, mode.delay); else send();
  });
  const cert = selfSigned();
  secure = httpsServer(cert, (_req, res) => { res.writeHead(200); res.end("ok"); });
  tcp = tcpServer(s => s.end());
  webUrl = `http://127.0.0.1:${await listen(web)}`; secureUrl = `https://127.0.0.1:${await listen(secure)}`; tcpPort = await listen(tcp);
  ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "homebase-mon-")), port: 0, host: "127.0.0.1", go2rtcUrl: null, webDir: join(tmpdir(), "none"), trustProxy: false, startPollers: false, publicPort: 0 });
  admin = cookieOf(await raw("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, H));
  await call("POST", "/api/users", { username: "look", password: "viewer password 1", role: "viewer" });
  viewer = cookieOf(await raw("POST", "/api/auth/login", { username: "look", password: "viewer password 1" }, H));
});
after(async () => { await ctx.app.close(); for (const s of [web, secure, tcp]) s.close(); });

test("a monitor is checked, shows up, and the form is validated in plain words", async () => {
  assert.equal((await call("POST", "/api/monitors", { kind: "http", target: "not a url" })).statusCode, 400);
  assert.equal((await call("POST", "/api/monitors", { kind: "http", target: "ftp://x.test" })).statusCode, 400);
  assert.equal((await call("POST", "/api/monitors", { kind: "tcp", target: "host", port: 70000 })).statusCode, 400);
  assert.equal((await call("POST", "/api/monitors", { kind: "keyword", target: webUrl })).statusCode, 400, "a keyword monitor needs a keyword");
  assert.equal((await call("POST", "/api/monitors", { kind: "http", target: webUrl, expect: "abc" })).statusCode, 400);
  assert.equal((await call("POST", "/api/monitors", { kind: "http", target: webUrl }, viewer)).statusCode, 403, "viewers cannot add monitors");
  const made = (await call("POST", "/api/monitors", { name: "Web", kind: "http", target: webUrl, retries: 1 })).json();
  assert.equal(made.intervalSeconds, 60); assert.equal(made.expect, "200-299");
  const r = (await call("POST", `/api/monitors/${made.id}/check`)).json();
  assert.equal(r.up, true); assert.equal(r.state, "up"); assert.match(r.message, /HTTP 200/);
  const v = await view(made.id);
  assert.equal(v.state, "up"); assert.equal(v.uptime24h, 100); assert.deepEqual(v.strip, [1]); assert.equal(v.config.target, webUrl);
  const asViewer = await view(made.id, viewer);
  assert.equal(asViewer.state, "up"); assert.equal(asViewer.config, undefined, "viewers do not see addresses");
});

test("retries: a failure is pending first, down once the retries run out, and recovery is logged", async () => {
  const id = (await call("POST", "/api/monitors", { name: "Flaky", kind: "http", target: webUrl, retries: 2 })).json().id;
  mode = { status: 503, body: "", delay: 0 };
  assert.equal((await call("POST", `/api/monitors/${id}/check`)).json().state, "pending");
  assert.equal((await call("POST", `/api/monitors/${id}/check`)).json().state, "pending");
  const third = (await call("POST", `/api/monitors/${id}/check`)).json();
  assert.equal(third.state, "down"); assert.match(third.message, /HTTP 503 \(expected 200-299\)/);
  mode = { status: 200, body: "<h1>Hello world</h1>", delay: 0 };
  assert.equal((await call("POST", `/api/monitors/${id}/check`)).json().state, "up");
  const v = await view(id);
  assert.deepEqual(v.strip, [2, 2, 0, 1]);
  assert.equal(v.uptime24h, 50, "pending tries are not counted either way: one down and one up");
  const log = ctx.db.prepare("SELECT level, message FROM events WHERE source = 'monitors' AND message LIKE 'Flaky%'").all() as any[];
  assert.ok(log.some(e => e.level === "error" && /Flaky is down: HTTP 503/.test(e.message)));
  assert.ok(log.some(e => e.level === "info" && /Flaky is back up after/.test(e.message)));
});

test("status code ranges, HEAD, redirects, keywords (also inverted), timeouts and closed ports", async () => {
  const make = async (b: object) => (await call("POST", "/api/monitors", { retries: 0, ...b })).json().id as string;
  const check = async (id: string) => (await call("POST", `/api/monitors/${id}/check`)).json();
  mode = { status: 404, body: "gone", delay: 0 };
  assert.equal((await check(await make({ kind: "http", target: webUrl, expect: "200-299,404" }))).up, true, "404 is allowed when listed");
  assert.equal((await check(await make({ kind: "http", target: webUrl }))).up, false);
  mode = { status: 200, body: "<h1>Hello world</h1>", delay: 0 };
  assert.equal((await check(await make({ kind: "http", target: webUrl, method: "HEAD" }))).up, true);
  assert.equal((await check(await make({ kind: "http", target: `${webUrl}/redirect` }))).up, true, "redirects are followed");
  assert.equal((await check(await make({ kind: "keyword", target: webUrl, keyword: "HELLO" }))).up, true, "keywords ignore case");
  const missing = await check(await make({ kind: "keyword", target: webUrl, keyword: "goodbye" }));
  assert.equal(missing.up, false); assert.match(missing.message, /does not contain "goodbye"/);
  const inv = await check(await make({ kind: "keyword", target: webUrl, keyword: "hello", invert: true }));
  assert.equal(inv.up, false); assert.match(inv.message, /contains "hello"/);
  mode = { status: 200, body: "slow", delay: 1800 };
  const slow = await check(await make({ kind: "http", target: webUrl, timeoutSeconds: 1, intervalSeconds: 20 }));
  assert.equal(slow.up, false); assert.match(slow.message, /Timed out after 1 s/);
  mode = { status: 200, body: "<h1>Hello world</h1>", delay: 0 };
  const dead = await check(await make({ kind: "http", target: `http://127.0.0.1:${await closedPort()}` }));
  assert.equal(dead.up, false); assert.match(dead.message, /refused/i);
  assert.equal((await check(await make({ kind: "tcp", target: "127.0.0.1", port: tcpPort }))).up, true);
  const noPort = await check(await make({ kind: "tcp", target: "127.0.0.1", port: await closedPort() }));
  assert.equal(noPort.up, false); assert.match(noPort.message, /refused/i);
});

test("https: a self-signed certificate fails unless allowed, and the certificate's end date is recorded", async () => {
  const strict = (await call("POST", "/api/monitors", { kind: "http", target: secureUrl, retries: 0 })).json().id;
  const bad = (await call("POST", `/api/monitors/${strict}/check`)).json();
  assert.equal(bad.up, false); assert.match(bad.message, /Certificate problem/);
  const lax = (await call("POST", "/api/monitors", { kind: "http", target: secureUrl, retries: 0, insecureTls: true, certWarnDays: 30 })).json().id;
  assert.equal((await call("POST", `/api/monitors/${lax}/check`)).json().up, true);
  const v = await view(lax);
  assert.ok(v.certExpires > Date.now() && v.certExpires < Date.now() + 3 * 86400_000, "the test certificate lasts two days");
  assert.ok((ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'monitors' AND message LIKE 'The certificate for%expires in%'").get() as any).n >= 1, "an expiring certificate is warned about");
});

test("DNS checks and the test button (nothing is saved)", async () => {
  const before = ((await call("GET", "/api/monitors")).json().items as any[]).length;
  const t = (await call("POST", "/api/monitors/test", { kind: "http", target: webUrl })).json();
  assert.equal(t.up, true);
  assert.equal(((await call("GET", "/api/monitors")).json().items as any[]).length, before);
  assert.equal((await call("POST", "/api/monitors/test", { kind: "dns", target: "bad host name!" })).statusCode, 400);
  const dns = (await call("POST", "/api/monitors/test", { kind: "dns", target: "example.invalid", dnsServer: "127.0.0.1", timeoutSeconds: 1 })).json();
  assert.equal(dns.up, false, "a name that cannot be resolved is down");
});

test("history, daily uptime and the pause switch", async () => {
  const id = (await call("POST", "/api/monitors", { name: "Hist", kind: "http", target: webUrl, retries: 0 })).json().id;
  for (let i = 0; i < 3; i++) await call("POST", `/api/monitors/${id}/check`);
  const h = (await call("GET", `/api/monitors/${id}/history?hours=24`, undefined, viewer)).json();
  assert.ok(h.points.length >= 1 && h.points.every((p: any) => typeof p.t === "number"));
  assert.equal(h.days.length, 90); assert.equal(h.days[89].up, 3); assert.equal(h.days[89].down, 0);
  assert.equal(h.uptimes.d1, 100); assert.ok(Array.isArray(h.events));
  assert.equal(h.recent.length, 3);
  assert.equal((await call("PUT", `/api/monitors/${id}`, { enabled: false })).json().enabled, false);
  assert.equal((await view(id)).state, "paused");
  assert.equal((await call("PUT", `/api/monitors/${id}`, { enabled: true, intervalSeconds: 5 })).json().intervalSeconds, 20, "never faster than every 20 seconds");
  assert.equal((await call("GET", "/api/monitors/nope/history")).statusCode, 404);
});

test("status pages: a link shows names, state and uptime only, and can be switched off or renewed", async () => {
  const ids = ((await call("GET", "/api/monitors")).json().items as any[]).slice(0, 2).map(m => m.id);
  assert.equal((await call("POST", "/api/status-pages", { title: "", monitors: ids })).statusCode, 400);
  assert.equal((await call("POST", "/api/status-pages", { title: "Home", monitors: ["nope"] })).statusCode, 400);
  assert.equal((await call("POST", "/api/status-pages", { title: "Home", monitors: ids }, viewer)).statusCode, 403);
  const page = (await call("POST", "/api/status-pages", { title: "Home lab", message: "All the things", monitors: ids })).json();
  assert.match(page.path, /^\/status\/[A-Za-z0-9_-]{30,}$/);
  const open = await raw("GET", `/api/status/${page.token}`); // no cookie: it is a public link
  assert.equal(open.statusCode, 200);
  const j = open.json();
  assert.equal(j.title, "Home lab"); assert.equal(j.monitors.length, 2); assert.ok(["up", "degraded", "down", "unknown"].includes(j.overall));
  const text = JSON.stringify(j);
  assert.ok(!text.includes(webUrl) && !text.includes("127.0.0.1") && !/message|config|target/.test(Object.keys(j.monitors[0]).join()), "no addresses or error texts leak");
  assert.equal(j.monitors[0].days.length, 45);
  assert.equal((await raw("GET", "/api/status/" + "x".repeat(32))).statusCode, 404);
  await call("PUT", `/api/status-pages/${page.id}`, { enabled: false });
  assert.equal((await raw("GET", `/api/status/${page.token}`)).statusCode, 404, "switched off");
  await call("PUT", `/api/status-pages/${page.id}`, { enabled: true });
  const renewed = (await call("POST", `/api/status-pages/${page.id}/new-link`)).json();
  assert.notEqual(renewed.token, page.token);
  assert.equal((await raw("GET", `/api/status/${page.token}`)).statusCode, 404, "the old link stopped working");
  assert.equal((await raw("GET", `/api/status/${renewed.token}`)).statusCode, 200);
  assert.equal((await raw("GET", "/api/status-pages")).statusCode, 401, "managing pages needs an administrator");
});

test("removing a monitor also removes its history and takes it off status pages", async () => {
  const victim = ((await call("GET", "/api/monitors")).json().items as any[])[0].id;
  assert.equal((await call("DELETE", `/api/monitors/${victim}`)).statusCode, 200);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM monitor_checks WHERE monitor_id = ?").get(victim) as any).n, 0);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM monitor_daily WHERE monitor_id = ?").get(victim) as any).n, 0);
  const pages = (await call("GET", "/api/status-pages")).json().items as any[];
  assert.ok(pages.every(p => !p.monitors.includes(victim)));
});

test("a JSON backup carries monitors and status pages, and a replace import restores them without their history", async () => {
  const file = (await call("POST", "/api/backup/export", {})).json();
  assert.ok(file.monitors.length >= 3 && file.statusPages.length === 1);
  assert.ok(file.monitors.every((m: any) => m.id && m.kind && m.target) && !JSON.stringify(file.statusPages).includes("token"));
  const count = file.monitors.length;
  const pre = (await call("POST", "/api/backup/import", { file, mode: "replace", dryRun: true })).json().preview;
  assert.equal(pre.monitors, count);
  await call("DELETE", `/api/monitors/${file.monitors[0].id}`);
  const res = (await call("POST", "/api/backup/import", { file, mode: "merge" })).json().result;
  assert.equal(res.added.monitors, 1, "a merge adds only the missing monitor");
  const res2 = (await call("POST", "/api/backup/import", { file, mode: "replace" })).json().result;
  assert.equal(res2.added.monitors, count);
  const mons = (await call("GET", "/api/monitors")).json().items as any[];
  assert.equal(mons.length, count);
  assert.ok(mons.every(m => m.strip.length === 0), "history is not part of a backup");
  const pages = (await call("GET", "/api/status-pages")).json().items as any[];
  assert.equal(pages.length, 1); assert.equal(pages[0].title, "Home lab");
  assert.equal((await raw("GET", `/api/status/${pages[0].token}`)).statusCode, 200, "the restored page has a working link");
});

test("groups, descriptions and bulk pause/resume", async () => {
  const mk = async (name: string, group: string) => (await call("POST", "/api/monitors", { name, group, description: "Part of " + group, kind: "tcp", target: "127.0.0.1", port: tcpPort, retries: 0 })).json();
  const a = await mk("Sonarr", "Arrs"), b = await mk("Radarr", "Arrs");
  assert.equal(a.group, "Arrs"); assert.equal(a.description, "Part of Arrs");
  const v = await view(a.id, viewer);
  assert.equal(v.group, "Arrs"); assert.equal(v.description, "Part of Arrs");
  assert.equal((await call("POST", "/api/monitors/bulk", { ids: [a.id, b.id], action: "pause" })).json().changed, 2);
  assert.equal((await view(b.id)).state, "paused");
  await call("POST", "/api/monitors/bulk", { ids: [a.id, b.id], action: "resume" });
  assert.notEqual((await view(b.id)).state, "paused");
  assert.equal((await call("POST", "/api/monitors/bulk", { ids: [], action: "pause" })).statusCode, 400);
  assert.equal((await call("POST", "/api/monitors/bulk", { ids: [a.id], action: "pause" }, viewer)).statusCode, 403);
  const page = (await call("POST", "/api/status-pages", { title: "Arrs", tone: "warn", message: "Planned work", monitors: [a.id, b.id] })).json();
  const pub = (await raw("GET", `/api/status/${page.token}`)).json();
  assert.equal(pub.tone, "warn"); assert.equal(pub.monitors[0].group, "Arrs");
});

test("JSON path, custom method, headers and basic auth, and upside-down mode", async () => {
  const seen: any[] = [];
  const api = httpServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      seen.push({ method: req.method, auth: req.headers.authorization, x: req.headers["x-test"], body });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { status: "ok", items: [{ n: 3 }] } }));
    });
  });
  const url = `http://127.0.0.1:${await listen(api)}`;
  try {
    const check = async (b: object) => (await call("POST", "/api/monitors/test", { retries: 0, target: url, ...b })).json();
    assert.equal((await check({ kind: "json", jsonPath: "data.status", keyword: "ok" })).up, true);
    assert.equal((await check({ kind: "json", jsonPath: "data.items.0.n", keyword: "3" })).up, true);
    const wrong = await check({ kind: "json", jsonPath: "data.status", keyword: "bad" });
    assert.equal(wrong.up, false); assert.match(wrong.message, /data\.status/);
    assert.equal((await check({ kind: "json", jsonPath: "data.nothing", keyword: "x" })).up, false);
    await check({ kind: "http", method: "POST", body: '{"a":1}', headers: "X-Test: hello", authUser: "me", authPass: "secret" });
    const last = seen[seen.length - 1];
    assert.equal(last.method, "POST"); assert.equal(last.body, '{"a":1}'); assert.equal(last.x, "hello");
    assert.equal(last.auth, "Basic " + Buffer.from("me:secret").toString("base64"));
    assert.equal((await check({ kind: "http", upsideDown: true })).up, false, "upside down: reachable counts as down");
    // Secrets are sealed in the database and never sent back.
    const m = (await call("POST", "/api/monitors", { name: "Auth", kind: "http", target: url, headers: "X-Test: hello", authUser: "me", authPass: "secret" })).json();
    assert.equal(m.hasAuthPass, true); assert.ok(!JSON.stringify(m).includes("secret"));
    const row = ctx.db.prepare("SELECT secret FROM monitors WHERE id = ?").get(m.id) as any;
    assert.ok(row.secret && !row.secret.includes("secret"));
    await call("PUT", `/api/monitors/${m.id}`, { name: "Auth 2" });
    await call("POST", `/api/monitors/${m.id}/check`);
    assert.equal(seen[seen.length - 1].auth, "Basic " + Buffer.from("me:secret").toString("base64"), "a blank password keeps the saved one");
    const exp = (await call("POST", "/api/backup/export", {})).json();
    assert.ok(!JSON.stringify(exp.monitors).includes('"secret"') && !JSON.stringify(exp.monitors).includes("X-Test") && exp.monitors.find((x: any) => x.id === m.id).secretsOmitted);
  } finally { api.close(); }
});

test("push monitors: a heartbeat marks them up, a missed one marks them down, a wrong address is refused", async () => {
  const m = (await call("POST", "/api/monitors", { name: "Backup job", kind: "push", intervalSeconds: 60, retries: 0 })).json();
  assert.match(m.target, /^[A-Za-z0-9_-]{16,}$/);
  assert.equal((await raw("GET", `/api/push/${m.target}?status=up&msg=done&ping=42`)).statusCode, 200);
  let v = await view(m.id);
  assert.equal(v.state, "up"); assert.equal(v.lastMs, 42);
  await raw("GET", `/api/push/${m.target}?status=down&msg=failed`);
  v = await view(m.id); assert.equal(v.state, "down");
  assert.equal((await raw("GET", "/api/push/nope-nope-nope-nope")).statusCode, 404);
  // No heartbeat for longer than the interval counts as down.
  await raw("GET", `/api/push/${m.target}`);
  (ctx.deps.monitors as any).beats.set(m.id, Date.now() - 3600_000);
  const missed = await ctx.deps.monitors.checkNow(m.id, true);
  assert.equal(missed?.state, "down"); assert.match(missed!.message, /No heartbeat/i);
});

test("maintenance windows: checks pause inside a window, and the rules are validated", async () => {
  const m = (await call("POST", "/api/monitors", { name: "Planned", kind: "http", target: webUrl, retries: 0 })).json();
  assert.equal((await call("POST", "/api/maintenance-windows", { title: "", kind: "once" })).statusCode, 400);
  assert.equal((await call("POST", "/api/maintenance-windows", { title: "x", kind: "once", startsAt: 5, endsAt: 1 })).statusCode, 400);
  assert.equal((await call("POST", "/api/maintenance-windows", { title: "x", kind: "weekly", startTime: "02:00", days: [] })).statusCode, 400);
  assert.equal((await call("POST", "/api/maintenance-windows", { title: "x", kind: "daily", startTime: "25:00" })).statusCode, 400);
  assert.equal((await call("POST", "/api/maintenance-windows", { title: "Patching", kind: "once", monitors: [m.id], startsAt: Date.now() - 1000, endsAt: Date.now() + 3600_000 }, viewer)).statusCode, 403);
  const w = (await call("POST", "/api/maintenance-windows", { title: "Patching", kind: "once", monitors: [m.id], startsAt: Date.now() - 1000, endsAt: Date.now() + 3600_000 })).json();
  mode = { status: 500, body: "", delay: 0 };
  const r = (await call("POST", `/api/monitors/${m.id}/check`)).json();
  assert.equal(r.state, "maintenance");
  assert.equal((await view(m.id)).state, "maintenance");
  mode = { status: 200, body: "<h1>Hello world</h1>", delay: 0 };
  await call("PUT", `/api/maintenance-windows/${w.id}`, { enabled: false });
  assert.equal((await call("POST", `/api/monitors/${m.id}/check`)).json().state, "up");
  // Recurring windows, including one that runs past midnight.
  const win = ctx.deps.monitors.windows;
  const at = (iso: string) => new Date(iso).getTime();
  const nightly = win.create({ title: "Nightly", kind: "daily", startTime: "23:30", durationMin: 120, monitors: [m.id] });
  assert.ok(win.active(m.id, at("2026-03-04T23:45:00Z"), "UTC", [nightly]));
  assert.ok(win.active(m.id, at("2026-03-05T01:00:00Z"), "UTC", [nightly]), "past midnight");
  assert.ok(!win.active(m.id, at("2026-03-05T02:00:00Z"), "UTC", [nightly]));
  const weekly = win.create({ title: "Sundays", kind: "weekly", startTime: "03:00", durationMin: 60, days: [0] });
  assert.ok(win.active("any", at("2026-03-01T03:30:00Z"), "UTC", [weekly]), "2026-03-01 is a Sunday");
  assert.ok(!win.active("any", at("2026-03-02T03:30:00Z"), "UTC", [weekly]));
  assert.ok(!win.active("any", at("2026-03-01T03:30:00Z"), "America/New_York", [weekly]), "the time zone is respected");
  assert.equal((await call("DELETE", `/api/maintenance-windows/${nightly.id}`)).statusCode, 200);
});

test("ping and certificate monitors give plain answers", async () => {
  const bad = (await call("POST", "/api/monitors/test", { kind: "ping", target: "-oProxy=x" }));
  assert.equal(bad.statusCode, 400, "a host name cannot start with a dash");
  const ping = (await call("POST", "/api/monitors/test", { kind: "ping", target: "127.0.0.1", timeoutSeconds: 2 })).json();
  assert.equal(typeof ping.up, "boolean"); assert.ok(ping.message.length > 0);
  const cert = (await call("POST", "/api/monitors/test", { kind: "cert", target: "127.0.0.1", port: Number(new URL(secureUrl).port), insecureTls: true, certWarnDays: 1 })).json();
  assert.equal(cert.up, true, "about two days remain and the warning is at one");
  const soon = (await call("POST", "/api/monitors/test", { kind: "cert", target: "127.0.0.1", port: Number(new URL(secureUrl).port), insecureTls: true, certWarnDays: 30 })).json();
  assert.equal(soon.up, false); assert.match(soon.message, /ends in/);
});
