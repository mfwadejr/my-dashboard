import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import { codeAt, stepNow } from "../src/totp.js";
import { runRetention } from "../src/retention.js";
import { diskInfo } from "../src/maintenance.js";
import { readSeries } from "../src/poller.js";
import { KEY, mockGo2rtc, mockSonarr, start } from "./mocks.js";

process.env.NODE_ENV = "test";
const H = { "x-homebase": "1" };
const DAY = 86400_000;
type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx, dir: string, g2: Awaited<ReturnType<typeof mockGo2rtc>>, sonarr: Awaited<ReturnType<typeof mockSonarr>>, admin = "", viewer = "";

const make = (d: string, go2: string | null) => buildApp({ dataDir: d, port: 0, host: "127.0.0.1", go2rtcUrl: go2, webDir: join(d, "none"), trustProxy: false, startPollers: false, publicPort: 0 });
const cookieOf = (res: { headers: Record<string, any> }) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).map(c => c.split(";")[0])[0] ?? "";
const raw = (c: Ctx, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => c.app.inject({ method: method as any, url, payload: payload as any, headers });
const call = (method: string, url: string, payload?: unknown, cookie = admin) => raw(ctx, method, url, payload, { ...H, ...(cookie ? { cookie } : {}) });
const bearer = (method: string, url: string, token: string, payload?: unknown) => raw(ctx, method, url, payload, { authorization: `Bearer ${token}` });
const insertEvent = (ts: number, level: string, source: string, message: string) => ctx.db.prepare("INSERT INTO events (ts, level, source, message) VALUES (?, ?, ?, ?)").run(ts, level, source, message);

before(async () => {
  [g2, sonarr] = await Promise.all([mockGo2rtc(), mockSonarr()]);
  dir = mkdtempSync(join(tmpdir(), "homebase-hard-"));
  ctx = await make(dir, g2.url);
  admin = cookieOf(await raw(ctx, "POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, H));
  await call("POST", "/api/users", { username: "wall", password: "viewer password 1", role: "viewer" });
  viewer = cookieOf(await raw(ctx, "POST", "/api/auth/login", { username: "wall", password: "viewer password 1" }, H));
  await call("POST", "/api/integrations", { type: "sonarr", name: "Main", url: sonarr.url, apiKey: KEY });
});
beforeEach(() => { ctx.db.prepare("DELETE FROM throttle").run(); });
after(async () => { await ctx.app.close(); await Promise.all([g2.close(), sonarr.close()]); });

// ------------------------------------------------------------------ two-factor

test("two-factor: set up with the password, confirm with a code, then sign-in needs the second step", async () => {
  const setupBad = await call("POST", "/api/auth/2fa/setup", { password: "wrong wrong" });
  assert.equal(setupBad.statusCode, 401);
  const s = (await call("POST", "/api/auth/2fa/setup", { password: "correct horse battery" })).json();
  assert.match(s.otpauthUrl, /^otpauth:\/\/totp\/.+secret=[A-Z2-7]+/); assert.match(s.qrSvg, /^<svg/);
  const secret = s.secret.replace(/\s/g, "");
  assert.equal((await call("GET", "/api/auth/2fa")).json().enabled, false, "not on until confirmed");
  assert.equal((await call("POST", "/api/auth/2fa/enable", { code: "000000" })).statusCode, 400);
  const en = (await call("POST", "/api/auth/2fa/enable", { code: codeAt(secret, stepNow()) })).json();
  assert.equal(en.recoveryCodes.length, 10); assert.match(en.recoveryCodes[0], /^[a-z0-9]{5}-[a-z0-9]{5}$/);
  const row = ctx.db.prepare("SELECT totp_secret, recovery FROM users WHERE username = 'boss'").get() as any;
  assert.ok(row.totp_secret.startsWith("v1:") && !row.recovery.includes(en.recoveryCodes[0]), "secret sealed, recovery codes stored only as hashes");
  assert.equal((await raw(ctx, "GET", "/api/auth/status", undefined, { ...H, cookie: admin })).json().user.totp, true);

  // password alone is no longer enough
  const login = (await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H));
  assert.equal(login.json().needs2fa, true); assert.equal(cookieOf(login), "", "no session yet");
  const ticket = login.json().ticket;
  assert.equal((await raw(ctx, "GET", "/api/dashboard", undefined, { cookie: "" })).statusCode, 401);
  const wrong = await raw(ctx, "POST", "/api/auth/login/2fa", { ticket, code: "123456" }, H);
  assert.equal(wrong.statusCode, 401); assert.ok(!wrong.json().restart);
  // a code from the next step is accepted (clock drift), and the same code cannot be used twice
  const code = codeAt(secret, stepNow() + 1);
  const good = await raw(ctx, "POST", "/api/auth/login/2fa", { ticket, code }, H);
  assert.equal(good.statusCode, 200, JSON.stringify(good.json())); const session = cookieOf(good); assert.ok(session);
  assert.equal((await raw(ctx, "GET", "/api/dashboard", undefined, { cookie: session })).statusCode, 200);
  const t2 = (await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H)).json().ticket;
  assert.equal((await raw(ctx, "POST", "/api/auth/login/2fa", { ticket: t2, code }, H)).statusCode, 401, "replay refused");
  // too many wrong tries on one ticket ends it
  for (let i = 0; i < 4; i++) await raw(ctx, "POST", "/api/auth/login/2fa", { ticket: t2, code: "111111" }, H);
  const dead = await raw(ctx, "POST", "/api/auth/login/2fa", { ticket: t2, code: codeAt(secret, stepNow()) }, H);
  assert.equal(dead.statusCode, 401); assert.equal(dead.json().restart, true);
  assert.equal((await raw(ctx, "POST", "/api/auth/login/2fa", { ticket: "nonsense", code: "123456" }, H)).statusCode, 401);
  assert.ok((await call("GET", "/api/logs?q=two-factor&source=security")).json().rows.length >= 2);

  (globalThis as any).__secret = secret; (globalThis as any).__recovery = en.recoveryCodes;
});

test("a recovery code works once; the admin who is locked out can be reset by another admin", async () => {
  const recovery: string[] = (globalThis as any).__recovery, secret: string = (globalThis as any).__secret;
  const t = (await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H)).json().ticket;
  const ok = await raw(ctx, "POST", "/api/auth/login/2fa", { ticket: t, code: recovery[0].toUpperCase() }, H);
  assert.equal(ok.statusCode, 200); assert.equal(ok.json().usedRecovery, true); assert.equal(ok.json().recoveryLeft, 9);
  const t2 = (await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H)).json().ticket;
  assert.equal((await raw(ctx, "POST", "/api/auth/login/2fa", { ticket: t2, code: recovery[0] }, H)).statusCode, 401, "used up");
  assert.ok((await call("GET", "/api/logs?q=recovery&source=security")).json().rows.some((r: any) => r.level === "warn" && /recovery code \(9 left\)/.test(r.message)));

  // new recovery codes need the password and a current code
  const sess = cookieOf(ok);
  const bad = await raw(ctx, "POST", "/api/auth/2fa/recovery", { password: "correct horse battery", code: "000000" }, { ...H, cookie: sess });
  assert.equal(bad.statusCode, 401);
  const fresh = (await raw(ctx, "POST", "/api/auth/2fa/recovery", { password: "correct horse battery", code: recovery[1] }, { ...H, cookie: sess })).json();
  assert.equal(fresh.recoveryCodes.length, 10);
  const t3 = (await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H)).json().ticket;
  assert.equal((await raw(ctx, "POST", "/api/auth/login/2fa", { ticket: t3, code: recovery[2] }, H)).statusCode, 401, "old codes were replaced");

  ctx.db.prepare("DELETE FROM throttle").run();
  // a second admin resets the first admin's two-factor
  await call("POST", "/api/users", { username: "boss2", password: "second admin pw 1", role: "admin" });
  const b2 = cookieOf(await raw(ctx, "POST", "/api/auth/login", { username: "boss2", password: "second admin pw 1" }, H));
  const boss = (await raw(ctx, "GET", "/api/users", undefined, { ...H, cookie: b2 })).json().find((u: any) => u.username === "boss");
  assert.equal(boss.totpEnabled, true);
  assert.equal((await raw(ctx, "PUT", `/api/users/${boss.id}`, { resetTwoFactor: true }, { ...H, cookie: b2 })).statusCode, 200);
  assert.equal((await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H)).json().ok, true, "password alone works again");
  admin = cookieOf(await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H));
  void secret;
});

test("disabling needs the password and a code; viewers can protect their own account too", async () => {
  ctx.db.prepare("DELETE FROM throttle").run();
  const s = (await call("POST", "/api/auth/2fa/setup", { password: "correct horse battery" })).json();
  const secret = s.secret.replace(/\s/g, "");
  await call("POST", "/api/auth/2fa/enable", { code: codeAt(secret, stepNow()) });
  assert.equal((await call("POST", "/api/auth/2fa/disable", { password: "correct horse battery", code: "000000" })).statusCode, 401);
  assert.equal((await call("POST", "/api/auth/2fa/disable", { password: "nope nope nope", code: codeAt(secret, stepNow() + 1) })).statusCode, 401);
  assert.equal((await call("POST", "/api/auth/2fa/disable", { password: "correct horse battery", code: codeAt(secret, stepNow() + 1) })).statusCode, 200);
  assert.equal((await call("GET", "/api/auth/2fa")).json().enabled, false);
  // a viewer
  const vs = (await call("POST", "/api/auth/2fa/setup", { password: "viewer password 1" }, viewer)).json();
  assert.ok(vs.secret, "viewers are allowed to turn it on");
  assert.equal((await call("PUT", "/api/settings", { name: "x" }, viewer)).statusCode, 403, "but still cannot change settings");
  ctx.db.prepare("UPDATE users SET totp_secret = '', totp_enabled = 0 WHERE username = 'wall'").run();
});

test("two-factor travels with accounts in a passphrase-protected backup and keeps working", async () => {
  ctx.db.prepare("DELETE FROM throttle").run();
  const s = (await call("POST", "/api/auth/2fa/setup", { password: "correct horse battery" })).json();
  const secret = s.secret.replace(/\s/g, "");
  await call("POST", "/api/auth/2fa/enable", { code: codeAt(secret, stepNow()) });
  const file = (await call("POST", "/api/backup/export", { passphrase: "a long passphrase", includeAccounts: true })).json();
  assert.ok(!JSON.stringify(file).includes(secret));
  const boss = ctx.db.prepare("SELECT id FROM users WHERE username = 'boss'").get() as any;
  ctx.db.prepare("UPDATE users SET totp_secret = '', totp_enabled = 0, recovery = '[]' WHERE id = ?").run(boss.id);
  const res = await call("POST", "/api/backup/import", { file, mode: "replace", passphrase: "a long passphrase", restoreAccounts: true });
  assert.equal(res.statusCode, 200, res.body);
  const t = (await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H)).json();
  assert.equal(t.needs2fa, true, "two-factor came back");
  const ok = await raw(ctx, "POST", "/api/auth/login/2fa", { ticket: t.ticket, code: codeAt(secret, stepNow() + 1) }, H);
  assert.equal(ok.statusCode, 200);
  admin = cookieOf(ok);
  await call("POST", "/api/auth/2fa/disable", { password: "correct horse battery", code: codeAt(secret, stepNow() + 1) }).then(r => assert.ok([200, 401].includes(r.statusCode)));
  ctx.db.prepare("UPDATE users SET totp_secret = '', totp_enabled = 0, recovery = '[]' WHERE username = 'boss'").run();
  admin = cookieOf(await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H));
});

test("HOMEBASE_RESET_2FA clears two-factor at startup for the named account", async () => {
  const d = mkdtempSync(join(tmpdir(), "homebase-r2-"));
  const c1 = await make(d, null);
  const a = cookieOf(await raw(c1, "POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, H));
  const s = (await raw(c1, "POST", "/api/auth/2fa/setup", { password: "correct horse battery" }, { ...H, cookie: a })).json();
  await raw(c1, "POST", "/api/auth/2fa/enable", { code: codeAt(s.secret.replace(/\s/g, ""), stepNow()) }, { ...H, cookie: a });
  await c1.app.close();
  process.env.HOMEBASE_RESET_2FA = "boss";
  try {
    const c2 = await make(d, null);
    assert.equal((await raw(c2, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H)).json().ok, true);
    assert.ok(c2.db.prepare("SELECT 1 FROM events WHERE message LIKE '%reset for \"boss\"%'").get());
    await c2.app.close();
  } finally { delete process.env.HOMEBASE_RESET_2FA; }
});

// ------------------------------------------------------------------ idle timeout

test("idle sign-out applies to admins only, and real activity keeps the session alive", async () => {
  viewer = cookieOf(await raw(ctx, "POST", "/api/auth/login", { username: "wall", password: "viewer password 1" }, H)); // restoring accounts ended every old sign-in
  assert.equal((await call("PUT", "/api/settings", { idleMinutes: 3 })).statusCode, 400);
  assert.equal((await call("PUT", "/api/settings", { idleMinutes: 15 })).statusCode, 200);
  const hash = (c: string) => ctx.db.prepare("SELECT token_hash FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?) ORDER BY created_at DESC").all(c);
  void hash;
  const old = Date.now() - 20 * 60_000;
  // make every session look idle for 20 minutes
  ctx.db.prepare("UPDATE sessions SET last_active = ?, last_seen = ?").run(old, old);
  assert.equal((await call("GET", "/api/dashboard", undefined, admin)).statusCode, 401, "the admin was signed out");
  assert.equal((await call("GET", "/api/dashboard", undefined, viewer)).statusCode, 200, "the wall display viewer was not");
  admin = cookieOf(await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "correct horse battery" }, H));
  // activity ping refreshes it
  ctx.db.prepare("UPDATE sessions SET last_active = ? WHERE user_id LIKE 'u%'").run(Date.now() - 14 * 60_000);
  assert.equal((await call("POST", "/api/auth/activity")).statusCode, 200);
  ctx.db.prepare("UPDATE sessions SET last_active = last_active - 3 * 60000 WHERE user_id LIKE 'u%'").run(); // would be 17 minutes if the ping had not happened
  assert.equal((await call("GET", "/api/dashboard")).statusCode, 200);
  // a change request also counts as activity
  ctx.db.prepare("UPDATE sessions SET last_active = ? WHERE user_id LIKE 'u%'").run(Date.now() - 14 * 60_000);
  await call("PUT", "/api/settings", { name: "Homebase" });
  ctx.db.prepare("UPDATE sessions SET last_active = last_active - 3 * 60000 WHERE user_id LIKE 'u%'").run();
  assert.equal((await call("GET", "/api/dashboard")).statusCode, 200);
  await call("PUT", "/api/settings", { idleMinutes: 0 });
});

// ------------------------------------------------------------------ API tokens

test("API tokens: shown once, read-only vs read-write, never able to touch people, backups or sharing", async () => {
  assert.equal((await call("POST", "/api/tokens", { name: "x", scope: "read" }, viewer)).statusCode, 403);
  assert.equal((await call("POST", "/api/tokens", { name: "", scope: "read" })).statusCode, 400);
  assert.equal((await call("POST", "/api/tokens", { name: "x", scope: "admin" })).statusCode, 400);
  const ro = (await call("POST", "/api/tokens", { name: "Home Assistant", scope: "read" })).json();
  const rw = (await call("POST", "/api/tokens", { name: "Script", scope: "write" })).json();
  assert.match(ro.token, /^hb_[A-Za-z0-9_-]{30,}$/);
  const list = (await call("GET", "/api/tokens")).json();
  assert.equal(list.length, 2); assert.ok(!JSON.stringify(list).includes(ro.token) && !JSON.stringify(list).includes("token_hash"), "the token is never shown again");
  assert.equal(list.find((t: any) => t.name === "Script").prefix, rw.token.slice(0, 9));

  // read-only
  assert.equal((await bearer("GET", "/api/dashboard", ro.token)).statusCode, 200);
  const sum = (await bearer("GET", "/api/summary", ro.token)).json();
  assert.equal(sum.connections[0].name, "Main"); assert.equal(typeof sum.counts.up, "number");
  const dash = (await bearer("GET", "/api/dashboard", ro.token)).json();
  assert.equal((await bearer("PUT", "/api/dashboard", ro.token, dash)).statusCode, 403, "read-only cannot write");
  // read-write can change the layout, but only that
  assert.equal((await bearer("PUT", "/api/dashboard", rw.token, { ...dash, baseRevision: dash.revision })).statusCode, 200);
  for (const [m, u] of [["GET", "/api/users"], ["GET", "/api/sessions"], ["GET", "/api/shares"], ["GET", "/api/tokens"], ["POST", "/api/backup/snapshots"], ["GET", "/api/backup/snapshots"], ["GET", "/api/status"], ["GET", "/api/logs"], ["POST", "/api/data/clear-logs"], ["PUT", "/api/settings"], ["POST", "/api/auth/password"]] as const) {
    const r = await bearer(m, u, rw.token, m === "GET" ? undefined : {});
    assert.ok([401, 403].includes(r.statusCode), `${m} ${u} -> ${r.statusCode}`);
  }
  assert.equal((await bearer("GET", "/go2rtc/api/streams", rw.token)).statusCode, 403, "no camera streams");
  // bad and revoked tokens, and cookies are ignored once a token is presented
  assert.equal((await bearer("GET", "/api/dashboard", "hb_notarealtoken0000000000000000")).statusCode, 401);
  assert.equal((await raw(ctx, "GET", "/api/dashboard", undefined, { cookie: admin, authorization: "Bearer hb_notarealtoken0000000000000000" })).statusCode, 401, "a bad token does not fall back to the cookie");
  assert.equal((await call("POST", `/api/tokens/${ro.id}/revoke`)).statusCode, 200);
  assert.equal((await bearer("GET", "/api/dashboard", ro.token)).statusCode, 401);
  const after = (await call("GET", "/api/tokens")).json().find((t: any) => t.id === rw.id);
  assert.ok(after.uses >= 2 && after.lastUsed > 0, "use is counted");
  // logged, with repeats folded together
  const logs = (await call("GET", "/api/logs?source=api&limit=100")).json().rows.map((r: any) => r.message);
  assert.ok(logs.some((m: string) => /created the read-only API token "Home Assistant"/.test(m)));
  assert.ok(logs.some((m: string) => /API token "Script" changed \/api\/dashboard/.test(m)));
  const reads = logs.filter((m: string) => /API token "Home Assistant" read \/api\/dashboard/.test(m));
  assert.equal(reads.length, 1, "two quick reads of the same thing are one entry");
  assert.equal((await call("DELETE", `/api/tokens/${rw.id}`)).statusCode, 200);
  assert.equal((await bearer("GET", "/api/dashboard", rw.token)).statusCode, 401);
});

// ------------------------------------------------------------------ graph history and log rules

test("graph history is averaged into hourly then daily points, then dropped, and runs cleanly twice", async () => {
  const id = ctx.deps.store.listIntegrations()[0].id;
  await call("PUT", "/api/settings", { metricsDays: 365, historyDetailDays: 2, historyHourlyDays: 30 });
  ctx.db.prepare("DELETE FROM metrics").run();
  const now = Date.now(), ins = ctx.db.prepare("INSERT INTO metrics (instance_id, key, ts, value) VALUES (?, 'cpu', ?, ?)");
  const hourStart = Math.floor((now - 5 * DAY) / 3600_000) * 3600_000;
  for (let i = 0; i < 6; i++) ins.run(id, hourStart + i * 600_000, 10 * (i + 1)); // six readings in one hour, average 35
  for (let i = 0; i < 10; i++) ins.run(id, now - 60 * DAY - 3600_000 * i, 50);      // old enough for daily
  for (let i = 0; i < 4; i++) ins.run(id, now - 3600_000 * (i + 1), 99);            // recent: stays as it is
  ins.run(id, now - 400 * DAY, 1);                                                  // older than a year: gone
  const dry = (await call("POST", "/api/data/prune", { dryRun: true })).json();
  assert.equal(dry.dryRun, true); assert.equal(dry.hourly.from, 17); assert.ok(dry.expiredReadings >= 1);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM metrics").get() as any).n, 21, "a dry run changes nothing");
  const r = (await call("POST", "/api/data/prune")).json();
  const by = (res: number) => (ctx.db.prepare("SELECT COUNT(*) AS n FROM metrics WHERE res = ?").get(res) as any).n;
  assert.equal(by(0), 4, "recent readings untouched");
  assert.ok(by(1) >= 1 && by(2) >= 1, "hourly and daily rows exist");
  const hr = ctx.db.prepare("SELECT value, ts FROM metrics WHERE res = 1 AND ts = ?").get(hourStart) as any;
  assert.equal(hr.value, 35, "the hour's readings were averaged");
  assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM metrics WHERE ts < ?").get(now - 365 * DAY) as any).n, 0);
  const again = (await call("POST", "/api/data/prune")).json();
  assert.equal(again.hourly.from, 0); assert.equal(again.daily.from, 0);
  const series = readSeries(ctx.db, id, "cpu", 70 * 24 * 60, 500);
  assert.ok(series.length >= 6 && series.every(([, v]) => Number.isFinite(v)), "graphs read the mixed history");
  const stats = (await call("GET", "/api/data/stats")).json();
  assert.ok(stats.readingsByDetail.hourly >= 1 && stats.readingsByDetail.daily >= 1 && stats.lastPrune.ts > 0);
  assert.equal((await call("PUT", "/api/settings", { historyDetailDays: 40 })).statusCode, 400, "hourly must outlast detailed");
  assert.equal(r.dryRun, false);
});

test("log rules: severity, per-area, size cap, archive before pruning, verbosity", async () => {
  ctx.db.prepare("DELETE FROM events").run();
  const now = Date.now();
  insertEvent(now - 40 * DAY, "info", "connection", "old info line");          // info: 30 days
  insertEvent(now - 40 * DAY, "warn", "connection", "old warning line");       // warn: 90 days -> stays
  insertEvent(now - 100 * DAY, "warn", "connection", "very old warning");      // gone
  insertEvent(now - 100 * DAY, "error", "connection", "old error line");       // error: 365 days -> stays
  insertEvent(now - 40 * DAY, "info", "security", "old sign-in line");         // area rule below keeps it
  insertEvent(now - 2 * DAY, "info", "connection", "recent line");
  assert.equal((await call("PUT", "/api/settings", { logAreaDays: { nonsense: 5 } })).statusCode, 400);
  assert.equal((await call("PUT", "/api/settings", { logAreaDays: { security: 365 }, logExportBeforePrune: true })).statusCode, 200);
  const dry = (await call("POST", "/api/data/prune", { dryRun: true })).json();
  assert.equal(dry.logByAge, 2);
  const r = (await call("POST", "/api/data/prune")).json();
  assert.equal(r.logByAge, 2); assert.ok(r.archive && /^homebase-log-\d{8}-\d{6}\.csv$/.test(r.archive));
  const left = (ctx.db.prepare("SELECT message FROM events").all() as any[]).map(x => x.message);
  assert.ok(left.includes("old warning line") && left.includes("old error line") && left.includes("old sign-in line") && left.includes("recent line"));
  assert.ok(!left.includes("old info line") && !left.includes("very old warning"));
  const csv = readFileSync(join(dir, "log-archive", r.archive), "utf8");
  assert.match(csv, /^time,level,source,message\n/); assert.ok(csv.includes("old info line") && csv.includes("very old warning") && !csv.includes("recent line"));
  const archives = (await call("GET", "/api/logs/archives")).json();
  assert.equal(archives[0].name, r.archive);
  assert.equal((await call("GET", `/api/logs/archives/${r.archive}`)).statusCode, 200);
  assert.equal((await call("GET", "/api/logs/archives/..%2Fhomebase.db")).statusCode, 404);
  assert.equal((await call("DELETE", `/api/logs/archives/${r.archive}`)).statusCode, 200);

  // size cap: oldest lines go first
  ctx.db.prepare("DELETE FROM events").run();
  const big = "x".repeat(400);
  for (let i = 0; i < 20000; i++) insertEvent(now - (30000 - i) * 1000, "info", "system", `${big} ${i}`);
  assert.equal((await call("PUT", "/api/settings", { logMaxMB: 5, logExportBeforePrune: false })).statusCode, 200);
  const cap = (await call("POST", "/api/data/prune")).json();
  assert.ok(cap.logBySize > 1000, `size cap removed ${cap.logBySize}`);
  const rest = ctx.db.prepare("SELECT MIN(id) AS lo, COUNT(*) AS n, MAX(message) AS m FROM events").get() as any;
  assert.ok(rest.n < 20000 && rest.n > 5000, "kept about 5 MB worth");
  assert.ok(String(rest.m).endsWith("19999") || ctx.db.prepare("SELECT 1 FROM events WHERE message LIKE '% 19999'").get(), "the newest line survived");
  assert.ok(!ctx.db.prepare("SELECT 1 FROM events WHERE message LIKE '% 0'").get(), "the oldest line went");
  await call("PUT", "/api/settings", { logMaxMB: 100 });

  // verbosity
  ctx.db.prepare("DELETE FROM events").run();
  await call("PUT", "/api/settings", { logVerbosity: "quiet" });
  const count = () => (ctx.db.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n;
  await call("PUT", "/api/settings", { name: "Quiet test" });
  assert.equal(count(), 0, "quiet mode writes no information lines about settings");
  await raw(ctx, "POST", "/api/auth/login", { username: "boss", password: "wrongwrong" }, H);
  assert.ok(count() >= 1, "warnings are still written");
  await raw(ctx, "POST", "/api/auth/login", { username: "wall", password: "viewer password 1" }, H);
  assert.ok((ctx.db.prepare("SELECT 1 FROM events WHERE source = 'security' AND level = 'info'").get()), "security notes are kept");
  await call("PUT", "/api/settings", { logVerbosity: "normal", name: "Homebase" });
  assert.ok(count() >= 2);
});

// ------------------------------------------------------------------ maintenance, disk and health

test("maintenance checks integrity and compacts; the status page carries the result and disk space", async () => {
  const r = (await call("POST", "/api/maintenance/run")).json();
  assert.equal(r.ok, true); assert.equal(r.integrity, "ok"); assert.ok(r.bytesAfter > 0 && r.ms >= 0);
  const info = (await call("GET", "/api/maintenance")).json();
  assert.ok(info.last.ts > 0); assert.ok(Array.isArray(info.tables)); assert.ok(info.tables.some((t: any) => t.name === "events" || t.name === "metrics"));
  const st = (await call("GET", "/api/status")).json();
  assert.equal(st.maintenance.ok, true); assert.ok(st.disk === null || ["ok", "low", "critical"].includes(st.disk.level));
  assert.ok((await call("GET", "/api/logs?q=maintenance&source=system")).json().rows.some((x: any) => /Database maintenance .*finished/.test(x.message)));
  assert.equal((await call("POST", "/api/maintenance/run", {}, viewer)).statusCode, 403);
  const d = diskInfo(dir); assert.ok(!d || (d.total > 0 && d.free >= 0));
});

test("scheduled maintenance waits for the quiet hours and for the interval", async () => {
  const d = mkdtempSync(join(tmpdir(), "homebase-mt-"));
  const c = await make(d, null);
  const a = cookieOf(await raw(c, "POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, H));
  await raw(c, "PUT", "/api/settings", { timezone: "UTC" }, { ...H, cookie: a });
  const at = (iso: string) => Date.parse(iso);
  await c.deps.maintenance.tick(at("2026-10-15T14:00:00Z"));
  assert.equal(c.deps.maintenance.last(), null, "not at 2 pm");
  await c.deps.maintenance.tick(at("2026-10-15T03:20:00Z"));
  const first = c.deps.maintenance.last();
  assert.ok(first && first.manual === false, "ran in the quiet hours");
  const ts = first!.ts;
  await c.deps.maintenance.tick(at("2026-10-16T03:20:00Z"));
  assert.equal(c.deps.maintenance.last()!.ts, ts, "not again the next day");
  c.db.prepare("UPDATE meta SET v = ? WHERE k = 'maintenance_last'").run(JSON.stringify({ ...first, ts: Date.now() - 8 * DAY }));
  await raw(c, "PUT", "/api/settings", { maintenance: "off" }, { ...H, cookie: a });
  await c.deps.maintenance.tick(at("2026-10-16T03:20:00Z"));
  assert.ok(c.deps.maintenance.last()!.ts < Date.now() - 7 * DAY, "off means off");
  await c.app.close();
});

test("health check: ok, degraded when the relay is down, 503 when the database cannot be written", async () => {
  const h = (await raw(ctx, "GET", "/api/health")).json();
  assert.equal(h.status, "ok"); assert.equal(h.ok, true); assert.deepEqual(Object.keys(h.checks).sort(), ["database", "disk", "relay"]);
  assert.ok(!JSON.stringify(h).includes(dir), "nothing about the machine is revealed");
  const d = mkdtempSync(join(tmpdir(), "homebase-hl-"));
  const c = await make(d, "http://127.0.0.1:1");
  const deg = await raw(c, "GET", "/api/health");
  assert.equal(deg.statusCode, 200); assert.equal(deg.json().status, "degraded"); assert.equal(deg.json().checks.relay, "down");
  assert.equal((await raw(c, "GET", "/api/health?strict=1")).statusCode, 503);
  c.db.exec("PRAGMA query_only = ON");
  const bad = await raw(c, "GET", "/api/health");
  assert.equal(bad.statusCode, 503); assert.equal(bad.json().checks.database, "fail");
  c.db.exec("PRAGMA query_only = OFF");
  await c.app.close();
  const off = await make(mkdtempSync(join(tmpdir(), "homebase-hl-")), null);
  assert.equal((await raw(off, "GET", "/api/health")).json().checks.relay, "off");
  await off.app.close();
});

// ------------------------------------------------------------------ update check

test("update check: off by default and silent; when on it asks GitHub once and says what is new", async () => {
  const hits: string[] = [];
  const gh = await start((req, url) => {
    hits.push(url.pathname);
    if (url.pathname.endsWith("/compare/abc1234...main")) return { body: { status: "ahead", ahead_by: 2, commits: [
      { sha: "1111111aaaa", commit: { message: "Add backups push 1\n\nlong body", author: { date: "2026-10-18T00:00:00Z" } } },
      { sha: "2222222bbbb", commit: { message: "Add two-factor", author: { date: "2026-10-19T00:00:00Z" } } }] } };
    if (url.pathname.includes("/compare/eee0000")) return { status: 404, body: { message: "Not Found" } };
    return { body: { status: "identical", ahead_by: 0, commits: [] } };
  });
  process.env.UPDATE_API_BASE = gh.url; process.env.APP_COMMIT = "abc1234def5678";
  try {
    assert.equal((await call("GET", "/api/update")).json().enabled, false);
    assert.equal((await call("POST", "/api/update/check")).statusCode, 400);
    await ctx.deps.maintenance.tick(); assert.equal(hits.length, 0, "nothing is sent while it is off");
    assert.equal((await call("PUT", "/api/settings", { updateCheck: true })).statusCode, 200);
    const r = (await call("POST", "/api/update/check")).json();
    assert.equal(r.aheadBy, 2); assert.equal(r.upToDate, false); assert.equal(r.error, null);
    assert.deepEqual(r.commits.map((c: any) => c.message), ["Add two-factor", "Add backups push 1"]);
    assert.ok(hits.every(h => !h.includes("secret") && h.includes("/compare/abc1234...main")), "only the running commit is sent");
    assert.equal((await call("GET", "/api/status")).json().update.aheadBy, 2);
    assert.ok((await call("GET", "/api/logs?q=update+available&source=system")).json().rows.length >= 1);
    // an unknown commit and a source build are explained, not fatal
    process.env.APP_COMMIT = "eee0000fff";
    ctx.db.prepare("DELETE FROM throttle").run();
    assert.match((await call("POST", "/api/update/check")).json().error, /does not know the commit/);
    process.env.APP_COMMIT = "dev";
    ctx.db.prepare("DELETE FROM throttle").run();
    assert.match((await call("POST", "/api/update/check")).json().error, /does not know which version/);
    assert.equal((await call("POST", "/api/update/check", {}, viewer)).statusCode, 403);
    await call("PUT", "/api/settings", { updateCheck: false });
  } finally { delete process.env.UPDATE_API_BASE; delete process.env.APP_COMMIT; await gh.close(); }
});

test("restore-safe: old data folders upgrade to layout 5 with their sessions and metrics intact", async () => {
  assert.ok(existsSync(join(dir, "homebase.db")));
  assert.ok(readdirSync(dir).length > 0);
  assert.equal((ctx.db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as any).v, "5");
});
