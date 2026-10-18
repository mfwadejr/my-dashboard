import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import { SCHEMA_VERSION, _MIGRATIONS, openDb, getMeta } from "../src/db.js";
import { SecretBox } from "../src/crypto.js";
import { isDue, lastSlot, nextSlot, sealSecrets } from "../src/backup.js";
import { verifyDatabaseFile } from "../src/verify.js";
import { mockSftp } from "./sftpmock.js";
import { KEY, mockGo2rtc, mockSonarr } from "./mocks.js";

process.env.NODE_ENV = "test";
const H = { "x-homebase": "1" };
type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx, dir: string, g2: Awaited<ReturnType<typeof mockGo2rtc>>, sonarr: Awaited<ReturnType<typeof mockSonarr>>, admin = "";

const make = (d: string, go2: string | null) => buildApp({ dataDir: d, port: 0, host: "127.0.0.1", go2rtcUrl: go2, webDir: join(d, "none"), trustProxy: false, startPollers: false, publicPort: 0 });
const cookieOf = (res: { headers: Record<string, any> }) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).map(c => c.split(";")[0])[0] ?? "";
const call = (c: Ctx, cookie: string, method: string, url: string, payload?: unknown) => c.app.inject({ method: method as any, url, payload: payload as any, headers: { ...H, cookie } });
const go = (method: string, url: string, payload?: unknown) => call(ctx, admin, method, url, payload);

function multipart(file: Buffer, filename: string, fields: Record<string, string> = {}) {
  const boundary = "----hb" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { ...H, cookie: admin, "content-type": `multipart/form-data; boundary=${boundary}` } };
}

before(async () => {
  [g2, sonarr] = await Promise.all([mockGo2rtc(), mockSonarr()]);
  dir = mkdtempSync(join(tmpdir(), "homebase-bk-"));
  ctx = await make(dir, g2.url);
  admin = cookieOf(await ctx.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "boss", password: "correct horse battery" }, headers: H }));
  await go("POST", "/api/integrations", { type: "sonarr", name: "Main", url: sonarr.url, apiKey: KEY });
});
after(async () => { await ctx.app.close(); await Promise.all([g2.close(), sonarr.close()]); });

test("a saved copy is verified: every check is reported and passes", async () => {
  const made = (await go("POST", "/api/backup/snapshots")).json();
  const list = (await go("GET", "/api/backup/snapshots")).json();
  assert.ok(list.find((x: any) => x.name === made.name)?.verified?.ok, "manual copies are checked when they are made");
  const r = (await go("POST", `/api/backup/snapshots/${made.name}/verify`)).json();
  assert.equal(r.ok, true); assert.equal(r.restorable, true);
  const ids = r.checks.map((c: any) => c.id);
  for (const want of ["sqlite", "integrity", "foreign", "layout", "counts", "secrets", "admin", "meta"]) assert.ok(ids.includes(want), `check ${want}`);
  assert.equal(r.counts.connections, 1); assert.equal(r.counts.accounts, 1); assert.equal(r.layout, SCHEMA_VERSION);
  assert.match(r.checks.find((c: any) => c.id === "secrets").detail, /1 saved password/);
  assert.equal((await go("POST", "/api/backup/snapshots/homebase-20200101-000000-nothere.db/verify")).statusCode, 404);
  assert.equal((await go("POST", "/api/backup/snapshots/..%2Fsecret.key/verify")).statusCode, 404);
});

test("verify catches damage, a different encryption key, a missing admin and a newer layout", async () => {
  const made = (await go("POST", "/api/backup/snapshots")).json();
  const copy = join(dir, "backups", made.name);
  // different key
  const other = new SecretBox(mkdtempSync(join(tmpdir(), "hb-key-")));
  const r1 = verifyDatabaseFile(copy, other, join(dir, "tmp"));
  assert.equal(r1.checks.find(c => c.id === "secrets")!.status, "fail"); assert.equal(r1.ok, false); assert.equal(r1.restorable, true, "a key problem warns but does not forbid a restore");
  // newer layout and no admin
  const bad = join(dir, "tmp-bad.db");
  writeFileSync(bad, readFileSync(copy));
  const raw = new DatabaseSync(bad); raw.exec("PRAGMA journal_mode=DELETE; UPDATE users SET disabled = 1; UPDATE meta SET v = '99' WHERE k = 'schema_version'"); raw.close();
  const r2 = verifyDatabaseFile(bad, ctx.deps.box, join(dir, "tmp"));
  assert.equal(r2.restorable, false); assert.match(r2.checks.find(c => c.id === "layout")!.detail, /newer Homebase/);
  // not a database / empty / truncated
  writeFileSync(bad, "hello world, I am not a database");
  assert.equal(verifyDatabaseFile(bad, ctx.deps.box, join(dir, "tmp")).restorable, false);
  writeFileSync(bad, readFileSync(copy).subarray(0, 5000));
  assert.equal(verifyDatabaseFile(bad, ctx.deps.box, join(dir, "tmp")).ok, false);
  // the temporary working folders are cleaned up
  assert.deepEqual(readdirSync(join(dir, "tmp")).filter(n => n.startsWith("verify-")), []);
});

test("Verify a file: database copies and JSON backups, with the passphrase checked", async () => {
  const made = (await go("POST", "/api/backup/snapshots")).json();
  const db = readFileSync(join(dir, "backups", made.name));
  const m1 = multipart(db, "mine.db");
  const r1 = (await ctx.app.inject({ method: "POST", url: "/api/backup/verify-file", ...m1 })).json();
  assert.equal(r1.kind, "database"); assert.equal(r1.ok, true);

  const json = (await go("POST", "/api/backup/export", { passphrase: "a long passphrase" })).json();
  const text = Buffer.from(JSON.stringify(json));
  const good = (await ctx.app.inject({ method: "POST", url: "/api/backup/verify-file", ...multipart(text, "b.json", { passphrase: "a long passphrase" }) })).json();
  assert.equal(good.kind, "json"); assert.equal(good.ok, true); assert.equal(good.checks.find((c: any) => c.id === "secrets").status, "pass");
  const wrong = (await ctx.app.inject({ method: "POST", url: "/api/backup/verify-file", ...multipart(text, "b.json", { passphrase: "not the passphrase" }) })).json();
  assert.equal(wrong.ok, false);
  const none = (await ctx.app.inject({ method: "POST", url: "/api/backup/verify-file", ...multipart(text, "b.json") })).json();
  assert.equal(none.checks.find((c: any) => c.id === "secrets").status, "warn");
  const junk = await ctx.app.inject({ method: "POST", url: "/api/backup/verify-file", ...multipart(Buffer.from("nope"), "x.txt") });
  assert.equal(junk.statusCode, 400);
  // not signed in
  const anon = await ctx.app.inject({ method: "POST", url: "/api/backup/verify-file", ...multipart(db, "x.db"), headers: { ...m1.headers, cookie: "" } });
  assert.equal(anon.statusCode, 401);
});

test("an uploaded database copy joins the list, but a damaged one is refused", async () => {
  const made = (await go("POST", "/api/backup/snapshots")).json();
  const db = readFileSync(join(dir, "backups", made.name));
  const ok = await ctx.app.inject({ method: "POST", url: "/api/backup/snapshots/upload", ...multipart(db, "from-laptop.db") });
  assert.equal(ok.statusCode, 200); assert.match(ok.json().name, /-uploaded\.db$/);
  assert.ok((await go("GET", "/api/backup/snapshots")).json().some((x: any) => x.name === ok.json().name));
  const bad = await ctx.app.inject({ method: "POST", url: "/api/backup/snapshots/upload", ...multipart(Buffer.from("garbage"), "x.db") });
  assert.equal(bad.statusCode, 400);
});

test("accounts travel in the JSON backup only with a passphrase, and come back on restore", async () => {
  await go("POST", "/api/users", { username: "wall", password: "viewer password 1", role: "viewer" });
  assert.equal((await go("POST", "/api/backup/export", { includeAccounts: true })).statusCode, 400, "needs a passphrase");
  const file = (await go("POST", "/api/backup/export", { passphrase: "a long passphrase", includeAccounts: true })).json();
  assert.equal(file.accountsIncluded, true);
  assert.ok(!JSON.stringify(file).includes("pass_hash"), "hashes only exist inside the sealed section");
  const plain = (await go("POST", "/api/backup/export", { passphrase: "a long passphrase" })).json();
  assert.equal(plain.accountsIncluded, false);

  const prev = (await go("POST", "/api/backup/import", { file, mode: "replace", passphrase: "a long passphrase", restoreAccounts: true, dryRun: true })).json().preview;
  assert.equal(prev.accounts.count, 2); assert.equal(prev.accounts.youWillBeSignedOut, true);
  const v = (await ctx.app.inject({ method: "POST", url: "/api/backup/verify-file", ...multipart(Buffer.from(JSON.stringify(file)), "a.json", { passphrase: "a long passphrase" }) })).json();
  assert.equal(v.checks.find((c: any) => c.id === "accounts").status, "pass");

  // delete the viewer, then restore the accounts: the viewer returns and can sign in with the old password
  const wall = (await go("GET", "/api/users")).json().find((u: any) => u.username === "wall");
  await go("DELETE", `/api/users/${wall.id}`);
  const res = await go("POST", "/api/backup/import", { file, mode: "merge", passphrase: "a long passphrase", restoreAccounts: true });
  assert.equal(res.json().result.accounts.added, 1);
  const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "wall", password: "viewer password 1" }, headers: H });
  assert.equal(login.statusCode, 200);
  // asking for accounts that are not in the file is an error
  assert.equal((await go("POST", "/api/backup/import", { file: plain, mode: "merge", passphrase: "a long passphrase", restoreAccounts: true })).statusCode, 400);
  // a file whose accounts have no active admin cannot replace the accounts
  const bad = JSON.parse(JSON.stringify(file));
  bad.secrets = sealSecrets("a long passphrase", { integrations: {}, cameras: {}, accounts: [{ id: "x1", username: "v", role: "viewer", pass_hash: "h", disabled: 0 }] });
  assert.equal((await go("POST", "/api/backup/import", { file: bad, mode: "replace", passphrase: "a long passphrase", restoreAccounts: true })).statusCode, 400);
});

test("restore: verified, a safety copy is saved, the swap happens at the next start, and the old state is back", async () => {
  const d2 = mkdtempSync(join(tmpdir(), "homebase-rs-"));
  const c2 = await make(d2, null);
  const adm = cookieOf(await c2.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "boss", password: "correct horse battery" }, headers: H }));
  const put = (name: string) => call(c2, adm, "PUT", "/api/settings", { name });
  await put("Before");
  const snap = (await call(c2, adm, "POST", "/api/backup/snapshots")).json();
  await put("After");
  let restarted = 0; c2.deps.restart = () => { restarted++; };
  assert.equal((await call(c2, adm, "POST", "/api/backup/snapshots/homebase-20200101-000000.db/restore", {})).statusCode, 404);
  // a damaged copy is refused and nothing is queued
  writeFileSync(join(d2, "backups", "homebase-20200101-000000-broken.db"), "not a database");
  const refused = await call(c2, adm, "POST", "/api/backup/snapshots/homebase-20200101-000000-broken.db/restore", {});
  assert.equal(refused.statusCode, 400); assert.ok(!existsSync(join(d2, "restore-pending.db")));
  const res = await call(c2, adm, "POST", `/api/backup/snapshots/${snap.name}/restore`, {});
  assert.equal(res.statusCode, 200); assert.equal(res.json().restarting, true);
  assert.ok(readdirSync(join(d2, "backups")).some(n => n.includes("before-restore")), "safety copy of the state being replaced");
  assert.ok(existsSync(join(d2, "restore-pending.db")));
  await new Promise(r => setTimeout(r, 1000)); assert.equal(restarted, 1);
  await c2.app.close();
  const db = openDb(d2);
  assert.equal(JSON.parse(getMeta(db, "settings")!).name, "Before");
  assert.ok(!existsSync(join(d2, "restore-pending.db")) && !existsSync(join(d2, "restore-pending.json")));
  assert.ok((db.prepare("SELECT message FROM events WHERE message LIKE 'The database was restored%'").get() as any), "the restore is logged");
  // the safety copy still has the state from just before the restore
  const safety = readdirSync(join(d2, "backups")).find(n => n.includes("before-restore"))!;
  const old = new DatabaseSync(join(d2, "backups", safety), { readOnly: true });
  assert.equal(JSON.parse((old.prepare("SELECT v FROM meta WHERE k='settings'").get() as any).v).name, "After");
  old.close(); db.close();
});

test("startup refuses a database from a newer version, and saves a safety copy before an upgrade", async () => {
  const d3 = mkdtempSync(join(tmpdir(), "homebase-up-"));
  openDb(d3).close();
  const raw = new DatabaseSync(join(d3, "homebase.db")); raw.exec(`UPDATE meta SET v='${SCHEMA_VERSION + 5}' WHERE k='schema_version'`); raw.close();
  assert.throws(() => openDb(d3), /newer Homebase/);
  assert.ok(!existsSync(join(d3, "backups")), "nothing was written");

  // build a layout-3 database by hand, then open it with the current version
  const d4 = mkdtempSync(join(tmpdir(), "homebase-up-"));
  const old = new DatabaseSync(join(d4, "homebase.db"));
  old.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  for (let i = 0; i < 3; i++) old.exec(_MIGRATIONS[i]);
  old.exec("INSERT INTO meta (k, v) VALUES ('schema_version', '3'), ('admin_hash', 'x:y')");
  old.close();
  const up = openDb(d4);
  assert.equal(getMeta(up, "schema_version"), String(SCHEMA_VERSION));
  const copies = readdirSync(join(d4, "backups")).filter(n => n.includes("before-upgrade"));
  assert.equal(copies.length, 1);
  const v = verifyDatabaseFile(join(d4, "backups", copies[0]), new SecretBox(d4), join(d4, "tmp"));
  assert.equal(v.layout, 3); assert.equal(v.restorable, true);
  assert.ok(up.prepare("SELECT 1 FROM events WHERE message LIKE '%upgraded from layout 3%'").get());
  up.close();
  // a fresh install does not make an upgrade copy
  const d5 = mkdtempSync(join(tmpdir(), "homebase-up-")); openDb(d5).close(); assert.ok(!existsSync(join(d5, "backups")));
});

test("schedule maths: 6 hours, daily and weekly, in the dashboard's time zone", () => {
  const s = { backupEvery: "daily" as const, backupTime: "02:00", backupDay: 0, timezone: "America/Chicago" };
  const now = Date.parse("2026-10-15T20:00:00Z"); // 15:00 in Chicago (CDT, UTC-5)
  assert.equal(lastSlot(now, s), Date.parse("2026-10-15T07:00:00Z"), "02:00 CDT is 07:00 UTC");
  assert.equal(isDue(now, s, Date.parse("2026-10-14T07:00:10Z")), true);
  assert.equal(isDue(now, s, Date.parse("2026-10-15T07:05:00Z")), false);
  assert.equal(isDue(now, s, null), true);
  assert.equal(nextSlot(now, s, Date.parse("2026-10-15T07:05:00Z")), Date.parse("2026-10-16T07:00:00Z"));
  // before 02:00 local, yesterday's slot is the latest
  assert.equal(lastSlot(Date.parse("2026-10-15T05:00:00Z"), s), Date.parse("2026-10-14T07:00:00Z"));
  // standard time (UTC-6) after the clocks change
  assert.equal(lastSlot(Date.parse("2026-11-10T20:00:00Z"), s), Date.parse("2026-11-10T08:00:00Z"));
  const six = { ...s, backupEvery: "6h" as const };
  assert.equal(isDue(now, six, now - 5 * 3600_000), false); assert.equal(isDue(now, six, now - 6 * 3600_000 - 1), true);
  assert.equal(nextSlot(now, six, now - 3600_000), now + 5 * 3600_000);
  // weekly on Sunday (0) at 03:30; 2026-10-15 is a Thursday
  const w = { ...s, backupEvery: "weekly" as const, backupTime: "03:30", backupDay: 0 };
  assert.equal(lastSlot(now, w), Date.parse("2026-10-11T08:30:00Z"));
  assert.equal(nextSlot(now, w, Date.parse("2026-10-11T08:31:00Z")), Date.parse("2026-10-18T08:30:00Z"));
  assert.equal(isDue(now, w, Date.parse("2026-10-12T00:00:00Z")), false);
});

test("settings accept the schedule, and a due schedule makes, verifies and logs a copy once", async () => {
  assert.equal((await go("PUT", "/api/settings", { backupEvery: "monthly" })).statusCode, 400);
  assert.equal((await go("PUT", "/api/settings", { backupTime: "25:00" })).statusCode, 400);
  assert.equal((await go("PUT", "/api/settings", { backupDay: 9 })).statusCode, 400);
  assert.equal((await go("PUT", "/api/settings", { backupEvery: "6h", backupTime: "04:15", backupDay: 3, autoBackup: true })).statusCode, 200);
  const before = ctx.deps.backups.list().filter(x => x.auto).length;
  await ctx.deps.backups.tick();
  const after1 = ctx.deps.backups.list().filter(x => x.auto);
  assert.equal(after1.length, before + 1);
  assert.equal(after1[0].verified?.ok, true);
  await ctx.deps.backups.tick();
  assert.equal(ctx.deps.backups.list().filter(x => x.auto).length, before + 1, "not due again yet");
  const logs = (await go("GET", "/api/logs?q=verified&source=backup")).json().rows;
  assert.ok(logs.some((r: any) => /Scheduled backup saved and verified/.test(r.message)));
  const sch = (await go("GET", "/api/backup/schedule")).json();
  assert.equal(sch.enabled, true); assert.ok(sch.nextAt > Date.now() + 5 * 3600_000 - 60_000);
  await go("PUT", "/api/settings", { autoBackup: false });
  assert.equal((await go("GET", "/api/backup/schedule")).json().nextAt, null);
  await go("PUT", "/api/settings", { autoBackup: true, backupEvery: "daily" });
});

test("network destinations: SFTP test pins the server, copies arrive, old ones are tidied, bad passwords are explained", async () => {
  const sftp = await mockSftp("nas", "secret");
  try {
    assert.equal((await go("POST", "/api/backup/destinations", { name: "NAS", kind: "sftp", host: "http://nas", username: "nas", password: "secret", path: "backups" })).statusCode, 400, "address must be a plain host");
    assert.equal((await go("POST", "/api/backup/destinations", { name: "NAS", kind: "sftp", host: "127.0.0.1", port: sftp.port, username: "nas", password: "secret", path: "../etc" })).statusCode, 400);
    assert.equal((await go("POST", "/api/backup/destinations", { name: "NAS", kind: "sftp", host: "127.0.0.1", port: sftp.port, username: "nas", path: "x" })).statusCode, 400, "password required");
    const made = (await go("POST", "/api/backup/destinations", { name: "NAS", kind: "sftp", host: "127.0.0.1", port: sftp.port, username: "nas", password: "secret", path: "homebase/copies", keep: 2 })).json();
    assert.equal(made.hasPassword, true); assert.ok(!JSON.stringify(made).includes("secret"));
    assert.ok(!getMeta(ctx.db, "backup_destinations")!.includes('"secret"') && getMeta(ctx.db, "backup_destinations")!.includes("v1:"), "the password is stored encrypted");
    // sending before the server's identity is known is refused
    const early = (await go("POST", `/api/backup/destinations/${made.id}/send`, {})).json();
    assert.equal(early.ok, false); assert.match(early.message, /Run Test first/);

    const t = (await go("POST", `/api/backup/destinations/${made.id}/test`)).json();
    assert.equal(t.ok, true, t.message); assert.match(t.message, /now trusted/);
    assert.deepEqual(sftp.names(), [], "the test file is removed again");
    const listed = (await go("GET", "/api/backup/destinations")).json().items[0];
    assert.ok(listed.hostKey && listed.lastOk === true);

    // three sends with keep=2 leaves the two newest
    const copies = ctx.deps.backups.list().slice(0, 3);
    assert.equal(copies.length, 3);
    for (const c of copies.reverse()) { const r = (await go("POST", `/api/backup/destinations/${made.id}/send`, { name: c.name })).json(); assert.equal(r.ok, true, r.message); }
    assert.equal(sftp.names().length, 2);
    assert.ok(sftp.names().every(n => /^homebase-\d{8}-\d{6}(-[a-z-]+)?\.db$/.test(n)));
    const sent = [...sftp.files.entries()][0];
    assert.equal(sent[1].subarray(0, 15).toString("latin1"), "SQLite format 3", "the file arrived intact");
    assert.ok(sent[0].startsWith("homebase/copies/"), "created the folder");

    // scheduled copies are sent automatically
    await go("PUT", "/api/settings", { backupEvery: "6h" });
    for (const f of readdirSync(join(dir, "backups"))) if (/^homebase-\d{8}-\d{6}\.db$/.test(f)) ctx.deps.backups.remove(f);
    const sentBefore = sftp.files.size;
    await ctx.deps.backups.tick();
    assert.ok(sftp.files.size >= 1 && sftp.names().length === 2 && sftp.files.size >= Math.min(sentBefore, 2));
    assert.ok((await go("GET", "/api/logs?q=sent&source=backup")).json().rows.some((r: any) => /sent a database copy to "NAS"/.test(r.message)));

    // wrong password is explained in plain words; switching the password back works
    await go("PUT", `/api/backup/destinations/${made.id}`, { password: "wrong" });
    const bad = (await go("POST", `/api/backup/destinations/${made.id}/test`)).json();
    assert.equal(bad.ok, false); assert.match(bad.message, /user name or password/);
    await go("PUT", `/api/backup/destinations/${made.id}`, { password: "secret", enabled: false });
    assert.equal((await go("POST", `/api/backup/destinations/${made.id}/test`)).json().ok, true);

    // a changed server identity is refused loudly
    const raw = JSON.parse(getMeta(ctx.db, "backup_destinations")!); raw[0].hostKey = "00".repeat(32);
    ctx.db.prepare("UPDATE meta SET v = ? WHERE k = 'backup_destinations'").run(JSON.stringify(raw));
    const spoof = (await go("POST", `/api/backup/destinations/${made.id}/test`)).json();
    assert.equal(spoof.ok, false); assert.match(spoof.message, /identity changed/);
    // editing the host clears the pin so a deliberate move works
    await go("PUT", `/api/backup/destinations/${made.id}`, { host: "localhost" });
    assert.equal((await go("GET", "/api/backup/destinations")).json().items[0].hostKey, "");

    assert.equal((await call(ctx, "", "GET", "/api/backup/destinations")).statusCode, 401);
    assert.equal((await go("DELETE", `/api/backup/destinations/${made.id}`)).statusCode, 200);
    assert.equal((await go("GET", "/api/backup/destinations")).json().items.length, 0);
  } finally { await sftp.close(); }
});

test("an SMB destination validates its fields and says plainly when smbclient is missing", async () => {
  assert.equal((await go("POST", "/api/backup/destinations", { name: "UNAS", kind: "smb", host: "10.0.0.5", username: "bk", password: "p" })).statusCode, 400, "share required");
  assert.equal((await go("POST", "/api/backup/destinations", { name: "UNAS", kind: "smb", host: "10.0.0.5", share: "back;up", username: "bk", password: "p" })).statusCode, 400);
  assert.equal((await go("POST", "/api/backup/destinations", { name: "UNAS", kind: "smb", host: "10.0.0.5", share: "backups", username: "bk%pw", password: "p" })).statusCode, 400);
  const made = (await go("POST", "/api/backup/destinations", { name: "UNAS", kind: "smb", host: "127.0.0.1", port: 1, share: "backups", username: "bk", password: "p", path: "homebase" })).json();
  assert.equal(made.port, 1); assert.equal(made.share, "backups");
  const t = (await go("POST", `/api/backup/destinations/${made.id}/test`)).json();
  assert.equal(t.ok, false); assert.ok(t.message.length > 10 && !/ENOENT|spawn/.test(t.message), t.message);
  await go("DELETE", `/api/backup/destinations/${made.id}`);
});
