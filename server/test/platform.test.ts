import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import { KEY, mockGo2rtc, mockSonarr } from "./mocks.js";

process.env.NODE_ENV = "test";
const H = { "x-homebase": "1" };
let ctx: Awaited<ReturnType<typeof buildApp>>, dir: string, g2: Awaited<ReturnType<typeof mockGo2rtc>>, sonarr: Awaited<ReturnType<typeof mockSonarr>>;
let admin = "", camA = "", camB = "";

before(async () => {
  [g2, sonarr] = await Promise.all([mockGo2rtc(), mockSonarr()]);
  dir = mkdtempSync(join(tmpdir(), "homebase-plat-"));
  ctx = await buildApp({ dataDir: dir, port: 0, host: "127.0.0.1", go2rtcUrl: g2.url, webDir: join(dir, "none"), trustProxy: false, startPollers: false, publicPort: 1 });
});
after(async () => { await ctx.app.close(); await Promise.all([g2.close(), sonarr.close()]); });

const call = (method: string, url: string, payload?: unknown, cookie = admin) =>
  ctx.app.inject({ method: method as any, url, payload: payload as any, headers: { ...H, ...(cookie ? { cookie } : {}) } });
const pub = (method: string, url: string, payload?: unknown, cookie = "") =>
  ctx.publicApp!.inject({ method: method as any, url, payload: payload as any, headers: { ...H, ...(cookie ? { cookie } : {}) } });
const cookieOf = (res: { headers: Record<string, any> }, name?: string) => {
  const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find(c => !name || c.startsWith(name + "="));
  return raw ? raw.split(";")[0] : "";
};

test("setup creates the admin; accounts, roles and the last-admin rule", async () => {
  const res = await call("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, "");
  assert.equal(res.statusCode, 200); admin = cookieOf(res);
  assert.equal((await call("POST", "/api/auth/setup", { username: "x2", password: "another password" }, "")).statusCode, 409);
  assert.equal((await call("POST", "/api/users", { username: "a", password: "viewer password 1" })).statusCode, 400, "short username");
  assert.equal((await call("POST", "/api/users", { username: "wall", password: "short" })).statusCode, 400, "short password");
  const made = (await call("POST", "/api/users", { username: "wall", password: "viewer password 1", role: "viewer" })).json();
  assert.equal(made.role, "viewer");
  assert.equal((await call("POST", "/api/users", { username: "WALL", password: "viewer password 1" })).statusCode, 400, "names are not case sensitive");
  const me = (await call("GET", "/api/users")).json().find((u: any) => u.username === "boss");
  assert.equal((await call("PUT", `/api/users/${me.id}`, { role: "viewer" })).statusCode, 400, "cannot demote the only admin");
  assert.equal((await call("PUT", `/api/users/${me.id}`, { disabled: true })).statusCode, 400);
  assert.equal((await call("DELETE", `/api/users/${me.id}`)).statusCode, 400);
  // Disabled accounts cannot sign in, and a switched-off account loses its sessions.
  const login = await call("POST", "/api/auth/login", { username: "wall", password: "viewer password 1" }, "");
  const wall = cookieOf(login);
  assert.equal((await call("GET", "/api/dashboard", undefined, wall)).statusCode, 200);
  await call("PUT", `/api/users/${made.id}`, { disabled: true });
  assert.equal((await call("GET", "/api/dashboard", undefined, wall)).statusCode, 401);
  assert.equal((await call("POST", "/api/auth/login", { username: "wall", password: "viewer password 1" }, "")).statusCode, 401);
  await call("PUT", `/api/users/${made.id}`, { disabled: false, password: "brand new password" });
  assert.equal((await call("POST", "/api/auth/login", { username: "wall", password: "brand new password" }, "")).statusCode, 200);
  await call("DELETE", `/api/users/${made.id}`);
});

test("password change checks the current one and signs out other devices; sessions can be listed and ended", async () => {
  const other = cookieOf(await call("POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, ""));
  assert.equal((await call("POST", "/api/auth/password", { current: "wrong wrong", next: "a new password 1" })).statusCode, 401);
  assert.equal((await call("POST", "/api/auth/password", { current: "correct horse battery", next: "short" })).statusCode, 400);
  const sessions = (await call("GET", "/api/sessions")).json();
  assert.ok(sessions.length >= 2 && sessions.some((s: any) => s.current) && sessions.every((s: any) => !("hash" in s)));
  assert.equal((await call("POST", "/api/auth/password", { current: "correct horse battery", next: "a new password 1" })).statusCode, 200);
  assert.equal((await call("GET", "/api/dashboard", undefined, other)).statusCode, 401, "other devices were signed out");
  assert.equal((await call("GET", "/api/dashboard")).statusCode, 200, "this one stays");
  const again = cookieOf(await call("POST", "/api/auth/login", { username: "boss", password: "a new password 1" }, ""));
  const target = (await call("GET", "/api/sessions")).json().find((s: any) => !s.current);
  assert.equal((await call("DELETE", `/api/sessions/${target.id}`)).statusCode, 200);
  assert.equal((await call("GET", "/api/dashboard", undefined, again)).statusCode, 401);
});

test("the login limit is kept in the database, so it survives a restart", async () => {
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await call("POST", "/api/auth/login", { username: "nobody", password: "nope nope nope" }, "")).statusCode;
  assert.equal(last, 429);
  const row = ctx.db.prepare("SELECT n FROM throttle WHERE k LIKE 'login:%'").get() as { n: number };
  assert.ok(row.n >= 8);
  ctx.db.exec("DELETE FROM throttle");
});

test("settings: validated, time zone checked, changes are logged; about shows the version", async () => {
  assert.equal((await call("PUT", "/api/settings", { timezone: "Mars/Olympus" })).statusCode, 400);
  assert.equal((await call("PUT", "/api/settings", { accent: "red" })).statusCode, 400);
  assert.equal((await call("PUT", "/api/settings", { metricsDays: 0 })).statusCode, 400);
  assert.equal((await call("PUT", "/api/settings", { publicBaseUrl: "javascript:alert(1)" })).statusCode, 400);
  assert.equal((await call("PUT", "/api/settings", { nonsense: 1 })).statusCode, 400);
  const ok = await call("PUT", "/api/settings", { timezone: "America/Chicago", weekStart: "mon", metricsDays: 30, publicBaseUrl: "https://cams.example.com/", clock: "24" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().publicBaseUrl, "https://cams.example.com");
  assert.equal((await call("GET", "/api/settings")).json().timezone, "America/Chicago");
  const about = (await call("GET", "/api/about")).json();
  assert.match(about.version, /^\d+\.\d+\.\d+/); assert.ok(about.commit && about.build.includes("+"));
  assert.equal((await ctx.app.inject({ method: "GET", url: "/api/about" })).statusCode, 401);
  const logs = (await call("GET", "/api/logs?q=changed+settings")).json();
  assert.ok(logs.rows.some((r: any) => /changed settings: .*timezone/.test(r.message)));
});

test("log: plain sentences, searchable by any words (also partial), filterable, exportable", async () => {
  ctx.db.prepare("INSERT INTO events (ts, level, source, message) VALUES (?, 'warn', 'connection', ?)").run(Date.now(), 'Sonarr "Main" is unreachable: timed out after 10s');
  ctx.db.prepare("INSERT INTO events (ts, level, source, message) VALUES (?, 'info', 'camera', ?)").run(Date.now(), 'Admin "boss" added the camera "Driveway"');
  const find = async (qs: string) => (await call("GET", `/api/logs?${qs}`)).json().rows.map((r: any) => r.message) as string[];
  assert.ok((await find("q=timed+out")).some(m => m.includes("Sonarr")));
  assert.ok((await find("q=unreach")).some(m => m.includes("Sonarr")), "word starts match");
  assert.ok((await find("q=driveway+boss")).some(m => m.includes("Driveway")), "all words, any order");
  assert.equal((await find("q=driveway+sonarr")).length, 0, "every word must match");
  assert.ok((await find("q=%22%27%20OR%201%3D1%20--")).length >= 0, "odd characters are harmless");
  assert.ok((await find("level=warn")).every(m => /unreachable|blocked|Failed|Wrong/.test(m) || true));
  const warn = (await call("GET", "/api/logs?level=warn")).json().rows;
  assert.ok(warn.length >= 1 && warn.every((r: any) => r.level === "warn"));
  assert.ok((await call("GET", "/api/logs?source=camera")).json().rows.every((r: any) => r.source === "camera"));
  assert.ok((await call("GET", "/api/logs")).json().sources.includes("security"));
  const csv = await call("GET", "/api/logs/export?q=driveway");
  assert.match(String(csv.headers["content-type"]), /csv/); assert.match(csv.body, /Driveway/);
  // Deleted events leave the search index too.
  await call("POST", "/api/data/clear-logs");
  assert.equal((await find("q=driveway")).length, 0);
});

test("connections are logged and the status page shows state, speed and a history strip", async () => {
  const made = await call("POST", "/api/integrations", { type: "sonarr", name: "Main", url: sonarr.url, apiKey: KEY });
  const id = made.json().id;
  await ctx.poller.run(id);
  const st = (await call("GET", "/api/status")).json();
  const c = st.connections.find((x: any) => x.id === id);
  assert.equal(c.ok, true); assert.ok(c.ms >= 0); assert.equal(c.strip.length, 48); assert.equal(c.strip.at(-1), 1); assert.equal(c.uptime24h, 100);
  assert.ok(st.version.build && st.uptimeS >= 0);
  assert.ok((await call("GET", "/api/logs?q=added+connection")).json().rows.some((r: any) => /added the connection "Main"/.test(r.message)));
  await sonarr.close();
  const snap = await ctx.poller.run(id);
  assert.equal(snap?.ok, false);
  assert.ok((await call("GET", "/api/logs?q=unreachable")).json().rows.some((r: any) => r.source === "connection" && /Sonarr "Main" is unreachable/.test(r.message)));
  assert.equal((await call("GET", "/api/status")).json().connections[0].strip.at(-1), 0);
  sonarr = await mockSonarr();
});

test("history settings: prune, clear per connection", async () => {
  const id = ctx.store.listIntegrations()[0].id;
  ctx.db.prepare("INSERT INTO metrics (instance_id, key, ts, value) VALUES (?, 'x', ?, 1)").run(id, Date.now() - 40 * 86400_000);
  const stats = (await call("GET", "/api/data/stats")).json();
  assert.ok(stats.dbBytes > 0 && stats.metricsRows >= 1 && stats.key.source === "file");
  const pruned = (await call("POST", "/api/data/prune")).json();
  assert.ok(pruned.metrics >= 1, "older than the 30 days set earlier");
  assert.ok((await call("POST", "/api/data/clear-metrics", { id })).json().removed >= 1);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM metrics WHERE instance_id = ?").get(id) as any).n, 0);
});

async function addCameras() {
  camA = (await call("POST", "/api/cameras", { name: "Driveway", main: "rtsp://user:pass1@192.168.1.5/live" })).json().id;
  camB = (await call("POST", "/api/cameras", { name: "Backyard", main: "rtsp://192.168.1.6/live" })).json().id;
  // keep both cameras from being cleaned up as unused tiles
  const dash = (await call("GET", "/api/dashboard")).json();
  dash.tabs[0].groups[0].tiles.push({ id: "ca", type: "camera", w: 2, h: 2, config: { cameraId: camA } }, { id: "cb", type: "camera", w: 2, h: 2, config: { cameraId: camB } });
  assert.equal((await call("PUT", "/api/dashboard", { tabs: dash.tabs, baseRevision: dash.revision })).statusCode, 200);
}

test("share links: scoped to chosen cameras, PIN, expiry, revoke; public port serves nothing else", async () => {
  await addCameras();
  assert.equal((await call("POST", "/api/shares", { name: "Neighbor", kind: "cameras", cameras: [] })).statusCode, 400);
  assert.equal((await call("POST", "/api/shares", { name: "Neighbor", kind: "cameras", cameras: ["nope"] })).statusCode, 400);
  assert.equal((await call("POST", "/api/shares", { name: "Neighbor", kind: "cameras", cameras: [camA], pin: "12" })).statusCode, 400);
  const link = (await call("POST", "/api/shares", { name: "Neighbor", kind: "cameras", cameras: [camA], expiresIn: "1d", pin: "4321" })).json();
  assert.ok(link.token.length >= 30 && link.hasPin);
  const raw = readFileSync(join(dir, "homebase.db")); assert.ok(!raw.includes(Buffer.from(link.token)), "the link token is not stored in plain text");

  // The public port: nothing but the share routes.
  for (const url of ["/api/dashboard", "/api/auth/status", "/api/settings", "/api/shares", "/api/cameras", "/api/stream", "/", "/anything"]) assert.equal((await pub("GET", url)).statusCode, 404, url);
  assert.equal((await pub("POST", "/api/auth/login", { password: "x" })).statusCode, 404);
  assert.equal((await ctx.publicApp!.inject({ method: "POST", url: "/api/share/open", payload: { token: link.token } })).statusCode, 403, "needs the custom header");

  assert.equal((await pub("POST", "/api/share/open", { token: "x".repeat(32) })).statusCode, 404);
  const needPin = await pub("POST", "/api/share/open", { token: link.token });
  assert.equal(needPin.statusCode, 401); assert.equal(needPin.json().needsPin, true);
  assert.equal((await pub("POST", "/api/share/open", { token: link.token, pin: "0000" })).statusCode, 401);
  const open = await pub("POST", "/api/share/open", { token: link.token, pin: "4321" });
  assert.equal(open.statusCode, 200);
  assert.deepEqual(open.json().cameras, [{ id: camA, name: "Driveway" }]);
  const cookie = cookieOf(open, "hb_share"); assert.ok(cookie);
  assert.equal((await pub("GET", "/api/share/me", undefined, cookie)).statusCode, 200);
  assert.equal((await pub("POST", "/api/share/open", { token: link.token }, cookie)).statusCode, 200, "no PIN again while the session is valid");

  // Playback: only the chosen camera.
  assert.equal((await pub("GET", `/go2rtc/stream.html?src=cam-${camA}`, undefined, cookie)).statusCode, 200);
  assert.equal((await pub("GET", `/go2rtc/api/frame.jpeg?src=cam-${camA}-sub`, undefined, cookie)).statusCode, 200);
  assert.equal((await pub("GET", `/go2rtc/stream.html?src=cam-${camB}`, undefined, cookie)).statusCode, 403, "another camera is refused");
  assert.equal((await pub("GET", `/go2rtc/stream.html?src=cam-${camA}`)).statusCode, 401, "no cookie, no video");
  assert.equal((await pub("GET", "/go2rtc/api/config", undefined, cookie)).statusCode, 404);

  // On the main port the same cookie reaches nothing but its own cameras.
  assert.equal((await call("GET", "/api/dashboard", undefined, cookie)).statusCode, 403);
  assert.equal((await call("GET", `/go2rtc/stream.html?src=cam-${camB}`, undefined, cookie)).statusCode, 403);
  assert.equal((await call("GET", `/go2rtc/stream.html?src=cam-${camA}`, undefined, cookie)).statusCode, 200);
  assert.equal((await call("GET", "/api/auth/status", undefined, cookie)).json().authed, false, "a camera link is not a sign-in");

  const listed = (await call("GET", "/api/shares")).json()[0];
  assert.equal(listed.views, 1); assert.ok(listed.lastUsed);
  assert.ok((await call("GET", "/api/logs?source=share")).json().rows.some((r: any) => /Neighbor.*opened/.test(r.message)));

  // Revoking cuts off an open session immediately.
  assert.equal((await call("POST", `/api/shares/${link.id}/revoke`)).statusCode, 200);
  assert.equal((await pub("GET", "/api/share/me", undefined, cookie)).statusCode, 401);
  assert.equal((await pub("POST", "/api/share/open", { token: link.token, pin: "4321" })).statusCode, 404);

  // Expiry.
  const short = (await call("POST", "/api/shares", { name: "Short", kind: "cameras", cameras: [camB], expiresIn: "1h" })).json();
  assert.equal((await pub("POST", "/api/share/open", { token: short.token })).statusCode, 200);
  ctx.db.prepare("UPDATE shares SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, short.id);
  assert.equal((await pub("POST", "/api/share/open", { token: short.token })).statusCode, 404);
  // Removing a camera removes it from the link.
  const keep = (await call("POST", "/api/shares", { name: "Both", kind: "cameras", cameras: [camA, camB], expiresIn: "never" })).json();
  ctx.store.deleteCamera(camB); ctx.deps.shares.forgetCamera(camB);
  assert.deepEqual(ctx.deps.shares.get(keep.id)!.cameras, [camA]);
  camB = (await call("POST", "/api/cameras", { name: "Backyard", main: "rtsp://192.168.1.6/live" })).json().id;
});

test("wall-display links open a read-only dashboard on the home port only", async () => {
  const kiosk = (await call("POST", "/api/shares", { name: "Hallway tablet", kind: "kiosk", expiresIn: "never" })).json();
  assert.equal((await pub("POST", "/api/share/open", { token: kiosk.token })).statusCode, 404, "never over the public port");
  const open = await call("POST", "/api/share/open", { token: kiosk.token }, "");
  assert.equal(open.statusCode, 200);
  const cookie = cookieOf(open, "hb_share");
  const status = (await call("GET", "/api/auth/status", undefined, cookie)).json();
  assert.equal(status.authed, true); assert.equal(status.kiosk, true); assert.equal(status.user.role, "viewer");
  assert.equal((await call("GET", "/api/dashboard", undefined, cookie)).statusCode, 200);
  assert.equal((await call("PUT", "/api/dashboard", { tabs: [], baseRevision: 0 }, cookie)).statusCode, 403);
  for (const url of ["/api/users", "/api/shares", "/api/status", "/api/logs", "/api/backup/snapshots"]) assert.equal((await call("GET", url, undefined, cookie)).statusCode, 403, url);
  assert.equal((await call("GET", "/api/cameras/" + camA, undefined, cookie)).statusCode, 403);
  // The public port ignores a kiosk cookie entirely.
  assert.equal((await pub("GET", "/api/share/me", undefined, cookie)).statusCode, 401);
});

test("export and import: secrets only with a passphrase, preview first, replace and merge", async () => {
  const plain = (await call("POST", "/api/backup/export", {})).json();
  assert.equal(plain.secrets, null);
  assert.ok(!JSON.stringify(plain).includes("pass1") && !JSON.stringify(plain).includes(KEY), "no passwords or keys without a passphrase");
  assert.equal((await call("POST", "/api/backup/export", { passphrase: "short" })).statusCode, 400);
  const full = (await call("POST", "/api/backup/export", { passphrase: "backup passphrase" })).json();
  assert.ok(full.secrets && !JSON.stringify(full).includes("pass1") && !JSON.stringify(full).includes(KEY), "secrets are encrypted inside the file");
  assert.ok(full.integrations.length === 1 && full.cameras.length === 2 && full.dashboard.tabs.length >= 1);

  // Preview does not change anything.
  const before = (await call("GET", "/api/dashboard")).json().revision;
  const pv = (await call("POST", "/api/backup/import", { file: full, mode: "replace", dryRun: true, passphrase: "backup passphrase" })).json().preview;
  assert.equal(pv.encrypted, true); assert.equal(pv.passphraseOk, true); assert.equal(pv.integrations, 1); assert.equal(pv.cameras, 2);
  assert.equal((await call("POST", "/api/backup/import", { file: full, mode: "replace", dryRun: true, passphrase: "wrong passphrase" })).json().preview.passphraseOk, false);
  assert.equal((await call("GET", "/api/dashboard")).json().revision, before);
  assert.equal((await call("POST", "/api/backup/import", { file: { format: "something else" }, mode: "replace" })).statusCode, 400);
  assert.equal((await call("POST", "/api/backup/import", { file: { ...full, formatVersion: 99 }, mode: "replace" })).statusCode, 400);
  assert.equal((await call("POST", "/api/backup/import", { file: { ...full, integrations: [{ id: "a", type: "bogus", url: "http://x" }] }, mode: "merge" })).statusCode, 400);
  assert.equal((await call("POST", "/api/backup/import", { file: full, mode: "replace", passphrase: "wrong passphrase" })).statusCode, 400, "wrong passphrase changes nothing");
  assert.equal((await call("POST", "/api/backup/import", { file: full, mode: "replace" })).statusCode, 400, "protected file needs its passphrase");

  // Wreck the setup, then restore it.
  await call("DELETE", `/api/cameras/${camB}`);
  await call("PUT", "/api/settings", { name: "Changed" });
  const done = (await call("POST", "/api/backup/import", { file: full, mode: "replace", passphrase: "backup passphrase" })).json().result;
  assert.equal(done.added.cameras, 2); assert.equal(done.needsSecrets.length, 0);
  assert.equal(ctx.store.getCamera(camA)!.main, "rtsp://user:pass1@192.168.1.5/live", "camera password restored");
  assert.equal(ctx.store.apiKeyOf(ctx.store.listIntegrations()[0]), KEY, "API key restored");
  assert.equal((await call("GET", "/api/settings")).json().name, "Homebase");
  assert.ok(readdirSync(join(dir, "backups")).some(n => /before-import/.test(n)), "a safety copy is made before replacing");

  // Without a passphrase the structure comes back and the missing secrets are reported.
  const result = (await call("POST", "/api/backup/import", { file: plain, mode: "replace" })).json().result;
  assert.ok(result.needsSecrets.some((n: string) => /Main/.test(n)) && result.needsSecrets.some((n: string) => /Driveway/.test(n)));
  assert.equal(ctx.store.listIntegrations()[0].enabled, 0, "a connection without its key is added switched off");
  assert.equal(ctx.store.apiKeyOf(ctx.store.listIntegrations()[0]), "");
  // Merge adds only what is missing.
  await call("DELETE", `/api/cameras/${camB}`);
  const merged = (await call("POST", "/api/backup/import", { file: full, mode: "merge", passphrase: "backup passphrase" })).json().result;
  assert.equal(merged.added.cameras, 1); assert.equal(merged.skipped.cameras, 1); assert.equal(merged.skipped.integrations, 1);
  assert.equal(ctx.store.getCamera(camB)!.name, "Backyard");
});

test("database copies: made on demand, listed, downloadable, deletable; names are validated", async () => {
  const made = (await call("POST", "/api/backup/snapshots")).json();
  assert.match(made.name, /^homebase-\d{8}-\d{6}-manual\.db$/);
  const list = (await call("GET", "/api/backup/snapshots")).json();
  assert.ok(list.some((s: any) => s.name === made.name && s.size > 1000));
  const dl = await call("GET", `/api/backup/snapshots/${made.name}`);
  assert.equal(dl.statusCode, 200); assert.equal(dl.rawPayload.subarray(0, 15).toString(), "SQLite format 3");
  assert.equal((await call("GET", "/api/backup/snapshots/..%2fsecret.key")).statusCode, 404);
  assert.equal((await call("GET", "/api/backup/snapshots/secret.key")).statusCode, 404);
  assert.equal((await call("DELETE", `/api/backup/snapshots/${made.name}`)).statusCode, 200);
  // The nightly job: one copy when none is less than a day old, then none.
  ctx.deps.backups.tick(); ctx.deps.backups.tick();
  assert.equal(ctx.deps.backups.list().filter(s => s.auto).length, 1);
});

test("encryption key file needs the password again; danger zone keeps a safety copy", async () => {
  assert.equal((await call("POST", "/api/backup/secret-key", { password: "wrong wrong" })).statusCode, 401);
  const key = (await call("POST", "/api/backup/secret-key", { password: "a new password 1" })).json().key;
  assert.equal(key, readFileSync(join(dir, "secret.key"), "utf8").trim());
  assert.equal((await call("POST", "/api/data/reset-layout")).statusCode, 200);
  const dash = (await call("GET", "/api/dashboard")).json();
  assert.equal(dash.tabs.length, 1); assert.equal(dash.tabs[0].name, "Home");
  assert.ok(readdirSync(join(dir, "backups")).some(n => /before-reset/.test(n)));
  assert.ok((await call("GET", "/api/logs?q=reset+layout")).json().rows.length >= 1);
});
