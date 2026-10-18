import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import { KEY, inDays, mockGo2rtc, mockRadarr, mockSab, mockSonarr } from "./mocks.js";
import { mockUnifi } from "./mocks2.js";

process.env.NODE_ENV = "test";
const H = { "x-homebase": "1" };
let ctx: Awaited<ReturnType<typeof buildApp>>;
let dir: string;
let cookie = "";
let viewerCookie = "";
let sonarr: Awaited<ReturnType<typeof mockSonarr>>, radarr: Awaited<ReturnType<typeof mockRadarr>>, sab: Awaited<ReturnType<typeof mockSab>>, g2: Awaited<ReturnType<typeof mockGo2rtc>>;

before(async () => {
  [sonarr, radarr, sab, g2] = await Promise.all([mockSonarr(), mockRadarr(), mockSab(), mockGo2rtc()]);
  dir = mkdtempSync(join(tmpdir(), "homebase-"));
  ctx = await buildApp({ dataDir: dir, port: 0, host: "127.0.0.1", go2rtcUrl: g2.url, webDir: join(dir, "none"), trustProxy: false, startPollers: false });
});
after(async () => { await ctx.app.close(); await Promise.all([sonarr.close(), radarr.close(), sab.close(), g2.close()]); });

const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: method as any, url, payload: payload as any, headers: { ...H, ...(cookie ? { cookie } : {}), ...headers } });

test("first run seeds a dashboard and nothing is editable until setup", async () => {
  const status = (await call("GET", "/api/auth/status")).json();
  assert.deepEqual(status, { setup: false, authed: false, user: null, kiosk: false });
  assert.equal((await call("GET", "/api/dashboard")).statusCode, 401, "no anonymous viewing");
  assert.equal((await call("PUT", "/api/dashboard", { tabs: [], baseRevision: 0 })).statusCode, 401);
});

test("change requests without the custom header are rejected (CSRF guard)", async () => {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "x" } });
  assert.equal(res.statusCode, 403);
});

test("setup rejects short passwords, then sets one and signs in; a second setup is refused", async () => {
  assert.equal((await call("POST", "/api/auth/setup", { password: "short" })).statusCode, 400);
  const ok = await call("POST", "/api/auth/setup", { password: "correct horse battery" });
  assert.equal(ok.statusCode, 200);
  const set = ok.headers["set-cookie"] as string;
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Strict/i);
  cookie = set.split(";")[0];
  assert.equal((await call("POST", "/api/auth/setup", { password: "another password" })).statusCode, 409);
  assert.deepEqual((await call("GET", "/api/auth/status")).json(), { setup: true, authed: true, user: { id: (await call("GET", "/api/users")).json()[0].id, username: "admin", role: "admin" }, kiosk: false });
  const dash = (await call("GET", "/api/dashboard")).json();
  assert.equal(dash.tabs[0].name, "Home");
});

test("a viewer account can look but not change anything or reach admin pages", async () => {
  const made = await call("POST", "/api/users", { username: "guest", password: "viewer password 1", role: "viewer" });
  assert.equal(made.statusCode, 200);
  const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "guest", password: "viewer password 1" }, headers: H });
  assert.equal(login.statusCode, 200);
  viewerCookie = (login.headers["set-cookie"] as string).split(";")[0];
  const saved = cookie; cookie = viewerCookie;
  assert.equal((await call("GET", "/api/dashboard")).statusCode, 200);
  assert.equal((await call("GET", "/api/settings")).statusCode, 200);
  const dash = (await call("GET", "/api/dashboard")).json();
  assert.equal((await call("PUT", "/api/dashboard", { tabs: dash.tabs, baseRevision: dash.revision })).statusCode, 403);
  for (const url of ["/api/users", "/api/shares", "/api/status", "/api/logs", "/api/data/stats", "/api/backup/snapshots", "/api/sessions"]) assert.equal((await call("GET", url)).statusCode, 403, url);
  assert.equal((await call("PUT", "/api/settings", { name: "x" })).statusCode, 403);
  assert.equal((await call("POST", "/api/backup/export", {})).statusCode, 403);
  cookie = saved;
});

test("login: wrong password fails, right password works, logout ends the session", async () => {
  const saved = cookie; cookie = "";
  assert.equal((await call("POST", "/api/auth/login", { username: "admin", password: "nope nope nope" })).statusCode, 401);
  const ok = await call("POST", "/api/auth/login", { password: "correct horse battery" });
  assert.equal(ok.statusCode, 200);
  cookie = (ok.headers["set-cookie"] as string).split(";")[0];
  assert.equal((await call("POST", "/api/auth/logout")).statusCode, 200);
  assert.equal((await call("GET", "/api/auth/status")).json().authed, false);
  cookie = saved;
});

test("passwords are stored hashed, never in plain text", () => {
  const rows = ctx.db.prepare("SELECT pass_hash AS v FROM users").all() as Array<{ v: string }>;
  assert.ok(rows.length >= 2);
  for (const db of rows) { assert.match(db.v, /^scrypt\$/); assert.ok(!db.v.includes("correct horse") && !db.v.includes("viewer password")); }
});

test("dashboard: save, revision conflict, and validation", async () => {
  const dash = (await call("GET", "/api/dashboard")).json();
  const tabs = structuredClone(dash.tabs);
  tabs.push({ id: "media", name: "Media", emoji: "🎬", groups: [{ id: "g1", name: "Queues", layout: "grid2", collapsed: false, tiles: [{ id: "t1", type: "notes", w: 3, h: 2, config: { text: "hi" } }] }] });
  const saved = await call("PUT", "/api/dashboard", { tabs, baseRevision: dash.revision });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().revision, dash.revision + 1);
  assert.equal(saved.json().tabs[1].groups[0].tiles[0].config.text, "hi");

  const stale = await call("PUT", "/api/dashboard", { tabs, baseRevision: dash.revision });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().latest.revision, dash.revision + 1);

  const bad = structuredClone(tabs); bad[1].groups[0].tiles[0].type = "evil";
  assert.equal((await call("PUT", "/api/dashboard", { tabs: bad, baseRevision: dash.revision + 1 })).statusCode, 400);
  const dup = structuredClone(tabs); dup[1].id = dup[0].id;
  assert.equal((await call("PUT", "/api/dashboard", { tabs: dup, baseRevision: dash.revision + 1 })).statusCode, 400);
  const huge = structuredClone(tabs); huge[1].groups[0].tiles[0].config = { text: "x".repeat(30000) };
  assert.equal((await call("PUT", "/api/dashboard", { tabs: huge, baseRevision: dash.revision + 1 })).statusCode, 400);

  // Free placement: tile column/row and the group's auto-pack switch are saved; tiles without a spot stay without one.
  const placed = structuredClone(tabs); placed[1].groups[0].pack = true;
  placed[1].groups[0].tiles[0].x = 4; placed[1].groups[0].tiles[0].y = 7;
  placed[1].groups[0].tiles.push({ id: "t2", type: "notes", w: 2, h: 1, config: {} });
  const ok = await call("PUT", "/api/dashboard", { tabs: placed, baseRevision: dash.revision + 1 });
  assert.equal(ok.statusCode, 200);
  const g1 = ok.json().tabs[1].groups[0];
  assert.deepEqual([g1.pack, g1.tiles[0].x, g1.tiles[0].y, "x" in g1.tiles[1]], [true, 4, 7, false]);
  for (const [x, y] of [[12, 0], [-1, 0], [0, 401], [1.5, 0]]) {
    const badPos = structuredClone(placed); badPos[1].groups[0].tiles[0].x = x; badPos[1].groups[0].tiles[0].y = y;
    assert.equal((await call("PUT", "/api/dashboard", { tabs: badPos, baseRevision: dash.revision + 2 })).statusCode, 400, `${x},${y}`);
  }
});

test("integrations: viewers cannot manage them, test catches a wrong key and a wrong app", async () => {
  const anon = cookie; cookie = viewerCookie;
  assert.equal((await call("POST", "/api/integrations", { type: "sonarr", url: sonarr.url, apiKey: KEY })).statusCode, 403);
  assert.equal((await call("POST", "/api/integrations/test", { type: "sonarr", url: sonarr.url, apiKey: KEY })).statusCode, 403);
  cookie = anon;

  const good = (await call("POST", "/api/integrations/test", { type: "sonarr", url: sonarr.url, apiKey: KEY })).json();
  assert.equal(good.ok, true); assert.match(good.message, /Sonarr 4\.0\.9/);
  const bad = (await call("POST", "/api/integrations/test", { type: "sonarr", url: sonarr.url, apiKey: "wrong" })).json();
  assert.equal(bad.ok, false); assert.match(bad.message, /rejected the API key/);
  const swapped = (await call("POST", "/api/integrations/test", { type: "sonarr", url: radarr.url, apiKey: KEY })).json();
  assert.equal(swapped.ok, false); assert.match(swapped.message, /not Sonarr/);
  const sabBad = (await call("POST", "/api/integrations/test", { type: "sabnzbd", url: sab.url, apiKey: "wrong" })).json();
  assert.equal(sabBad.ok, false); assert.match(sabBad.message, /API Key Incorrect/);
  const dead = (await call("POST", "/api/integrations/test", { type: "radarr", url: "http://127.0.0.1:9", apiKey: KEY })).json();
  assert.equal(dead.ok, false); assert.match(dead.message, /Could not reach/);
  assert.ok(!JSON.stringify([good, bad, sabBad, dead]).includes(KEY), "API key must never appear in test results");
  assert.equal((await call("POST", "/api/integrations", { type: "sonarr", url: "ftp://x", apiKey: KEY })).statusCode, 400);
});

let sonarrId = "", radarrId = "", sabId = "";
test("integrations: create, poll and read normalized data for Sonarr, Radarr and SABnzbd", async () => {
  sonarrId = (await call("POST", "/api/integrations", { type: "sonarr", name: "TV", url: sonarr.url + "/", apiKey: KEY })).json().id;
  radarrId = (await call("POST", "/api/integrations", { type: "radarr", name: "Movies", url: radarr.url, apiKey: KEY })).json().id;
  sabId = (await call("POST", "/api/integrations", { type: "sabnzbd", name: "Usenet", url: sab.url, apiKey: KEY })).json().id;
  for (const id of [sonarrId, radarrId, sabId]) assert.equal((await ctx.poller.run(id))?.ok, true, id);

  const data = (await call("GET", "/api/data")).json();
  const s = data[sonarrId].data;
  assert.equal(s.queue.count, 2); assert.equal(s.queue.items[0].title, "Severance");
  assert.equal(s.queue.items[0].subtitle, "S01E02 Half Loop"); assert.equal(s.queue.items[0].progress, 0.75);
  assert.equal(s.missing, 7); assert.equal(s.health.issues, 1); assert.equal(s.libraryCount, 3);
  assert.deepEqual(s.upcoming.map((e: any) => e.subtitle), ["S01E02 Got it", "S01E03 Soon", "S01E05 Later"], "upcoming episodes are sorted soonest first");
  assert.deepEqual([s.monitoredCount, s.cutoffUnmet, s.troubleCount], [2, 4, 1]);
  assert.deepEqual([s.queue.items[1].trouble, s.queue.items[1].messages[0], s.queue.items[1].quality, s.queue.items[1].client, s.queue.items[0].trouble], [true, "No files found are eligible for import", "WEBDL-1080p", "SABnzbd", false]);
  assert.deepEqual([s.recent[0].title, s.recent[0].subtitle, s.recent[0].quality], ["Severance", "S01E01 Good News", "HDTV-720p"]);
  assert.equal(s.disks.length, 1, "the same drive listed twice is shown once"); assert.equal(s.disks[0].label, "TV");
  const r = data[radarrId].data;
  assert.equal(r.queue.items[0].title, "Dune"); assert.equal(r.queue.items[0].subtitle, "2021"); assert.ok(r.upcoming.some((e: any) => e.title === "Soon Movie")); assert.equal(r.libraryCount, 2);
  const z = data[sabId].data;
  assert.equal(z.speedKBs, 10240.5); assert.equal(z.queue.items[0].progress, 0.75); assert.equal(z.queue.sizeLeftMB, 1250.25); assert.equal(z.history[0].name, "Done.Item"); assert.equal(z.paused, false);
  assert.deepEqual([z.diskFreeGB, z.diskTotalGB, z.speedLimitPct, z.warnings, z.status], [512.3, 1000, 50, 2, "Downloading"]);
  assert.deepEqual([z.history[1].status, z.history[1].category, z.history[1].failMessage], ["Failed", null, "Aborted, cannot be completed"]);
  assert.deepEqual(z.totals, { day: "1.5 G", week: "9 G", month: "40 G", all: "1 T" });
  assert.equal(z.queue.items[1].category, "tv");
  // header vs query-string auth
  assert.ok(sonarr.hits.every(h => !h.includes(KEY)), "Sonarr key must go in a header, not the URL");
});

test("integrations: SABnzbd pause/resume action works and refreshes the data", async () => {
  assert.equal((await call("POST", `/api/integrations/${sabId}/actions/pause`)).statusCode, 200);
  assert.equal(sab.state.paused, true);
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await call("GET", `/api/data`)).json()[sabId].data.paused, true);
  assert.equal((await call("POST", `/api/integrations/${sabId}/actions/resume`)).statusCode, 200);
  assert.equal((await call("POST", `/api/integrations/${sabId}/actions/explode`)).statusCode, 404);
});

test("integrations: SABnzbd per-job actions, retry, speed limit, and hostile ids are refused", async () => {
  const act = (name: string, body: unknown) => call("POST", `/api/integrations/${sabId}/actions/${name}`, body);
  sab.state.calls.length = 0;
  assert.equal((await act("pausejob", { id: "SABnzbd_nzo_a" })).statusCode, 200);
  assert.equal((await act("resumejob", { id: "SABnzbd_nzo_a" })).statusCode, 200);
  assert.equal((await act("deletejob", { id: "SABnzbd_nzo_b" })).statusCode, 200);
  assert.equal((await act("retry", { id: "SABnzbd_nzo_h2" })).statusCode, 200);
  assert.equal((await act("removehistory", { id: "SABnzbd_nzo_h2" })).statusCode, 200);
  assert.equal((await act("speedlimit", { percent: 25 })).statusCode, 200);
  assert.deepEqual(sab.state.calls, ["queue:pause:SABnzbd_nzo_a", "queue:resume:SABnzbd_nzo_a", "queue:delete:SABnzbd_nzo_b", "retry::SABnzbd_nzo_h2", "history:delete:SABnzbd_nzo_h2", "config:speedlimit:25"]);
  const before = sab.state.calls.length;
  for (const bad of [{ id: "a&mode=shutdown" }, { id: "" }, { id: "../x" }, {}]) assert.equal((await act("deletejob", bad)).statusCode, 502, JSON.stringify(bad));
  for (const bad of [{ percent: 101 }, { percent: -1 }, { percent: "50; rm" }, { percent: 1.5 }, { percent: "" }, {}]) assert.equal((await act("speedlimit", bad)).statusCode, 502, JSON.stringify(bad));
  assert.equal(sab.state.calls.length, before, "refused requests never reach SABnzbd");
});

test("calendar: merges Sonarr and Radarr, marks state, proxies posters safely, validates input", async () => {
  const range = `start=${encodeURIComponent(inDays(-20))}&end=${encodeURIComponent(inDays(48))}`;
  const cal = async (extra = "") => (await call("GET", `/api/calendar?ids=${sonarrId},${radarrId},${sabId}&${range}${extra}`)).json();
  const digital = await cal("&release=digital");
  assert.deepEqual(digital.sources.map((x: any) => x.type).sort(), ["radarr", "sonarr"], "only Sonarr and Radarr connections are used");
  const by = (list: any[], title: string, sub?: string) => list.find((e: any) => e.title === title && (sub === undefined || e.subtitle.includes(sub)));
  assert.equal(by(digital.entries, "Severance", "Got it").state, "downloaded");
  assert.equal(by(digital.entries, "Severance", "Soon").state, "downloading", "an episode in the queue is downloading");
  assert.equal(by(digital.entries, "Andor").state, "upcoming");
  assert.equal(by(digital.entries, "Old Movie").state, "downloading", "a movie in the queue is downloading");
  assert.deepEqual(digital.entries.filter((e: any) => e.title === "Soon Movie").map((e: any) => [e.releaseType, e.state, e.allDay]), [["Digital", "upcoming", true]]);
  assert.equal(by(digital.entries, "Severance", "Soon").allDay, false);
  assert.deepEqual(digital.entries.map((e: any) => e.date), [...digital.entries.map((e: any) => e.date)].sort((a, b) => Date.parse(a) - Date.parse(b)), "entries are in date order");
  const all = await cal("&release=all");
  assert.deepEqual(all.entries.filter((e: any) => e.title === "Soon Movie").map((e: any) => [e.releaseType, e.state]), [["Cinema", "released"], ["Digital", "upcoming"], ["Physical", "upcoming"]]);
  const poster = by(digital.entries, "Severance", "Soon").poster as string;
  assert.ok(poster.startsWith(`/api/media-image/${sonarrId}?p=`));
  assert.equal(by(digital.entries, "Severance", "Got it").poster, null, "a poster path outside the cover folder is dropped");
  assert.ok(!JSON.stringify(digital).includes(KEY) && !JSON.stringify(digital).includes(sonarr.url), "no key and no app address reach the browser");
  const img = await call("GET", poster);
  assert.equal(img.statusCode, 200); assert.equal(img.headers["content-type"], "image/png"); assert.equal(img.body, "PNGDATA");
  for (const bad of ["/etc/passwd", "/MediaCover/../x", "/MediaCover/1/poster.jpg%0d%0aX:1", "http://evil/MediaCover/1/p.jpg"]) assert.equal((await call("GET", `/api/media-image/${sonarrId}?p=${encodeURIComponent(bad)}`)).statusCode, 404, bad);
  assert.equal((await call("GET", `/api/media-image/${sabId}?p=${encodeURIComponent("/MediaCover/1/poster.jpg")}`)).statusCode, 404, "other connection types never serve images");
  assert.equal((await call("GET", `/api/calendar?${range}`)).statusCode, 400, "no connection chosen");
  assert.equal((await call("GET", `/api/calendar?ids=${sonarrId}&start=${encodeURIComponent(inDays(-100))}&end=${encodeURIComponent(inDays(100))}`)).statusCode, 400, "range too long");
  assert.equal((await call("GET", `/api/calendar?ids=${sonarrId}&start=nope&end=nope`)).statusCode, 400);
});

test("integrations: keys are encrypted at rest and never returned to anyone", async () => {
  const raw = ctx.db.prepare("SELECT secret FROM integrations").all() as Array<{ secret: string }>;
  assert.ok(raw.length === 3 && raw.every(r => r.secret.startsWith("v1:") && !r.secret.includes(KEY)));
  assert.ok(!readFileSync(join(dir, "homebase.db")).includes(Buffer.from(KEY)), "plain key must not be in the database file");
  const admin = (await call("GET", "/api/integrations")).json();
  assert.equal(admin[0].hasKey, true); assert.ok(!JSON.stringify(admin).includes(KEY));
  const anon = cookie; cookie = viewerCookie;
  const viewer = (await call("GET", "/api/integrations")).json();
  assert.ok(!("url" in viewer[0]) && !("hasKey" in viewer[0]), "viewers get names only");
  assert.ok(!JSON.stringify((await call("GET", "/api/data")).json()).includes(KEY));
  cookie = anon;
});

test("integrations: a failing app keeps its last good data, is marked stale, and logs an event", async () => {
  await call("PUT", `/api/integrations/${radarrId}`, { name: "Movies", url: "http://127.0.0.1:9" });
  const snap = await ctx.poller.run(radarrId);
  assert.equal(snap?.ok, false); assert.match(snap!.error!, /Could not reach/);
  assert.equal((snap!.data as any).queue.items[0].title, "Dune", "last good data kept");
  const events = (await call("GET", "/api/events")).json();
  assert.ok(events.some((e: any) => e.source === "connection" && /Movies.*unreachable/.test(e.message)), "the log has a readable sentence");
  await call("PUT", `/api/integrations/${radarrId}`, { name: "Movies", url: radarr.url });
  assert.equal((await ctx.poller.run(radarrId))?.ok, true, "key was kept when only the address changed");
});

test("metrics history is stored and served", async () => {
  const series = (await call("GET", `/api/metrics/${sonarrId}/queue_count?minutes=60`)).json();
  assert.ok(series.length >= 1); assert.equal(series[0][1], 2);
});

test("cameras: UniFi's secure rtsps link is converted to the plain rtsp address, and nothing else is touched", async () => {
  const made = await call("POST", "/api/cameras", { name: "Garage", main: "rtsps://192.168.1.2:7441/cameraToken12345?enableSrtp", sub: "rtsp://192.168.1.2:7447/tok2" });
  assert.equal(made.json().converted, true);
  assert.equal(g2.streams.get(`cam-${made.json().id}`), "rtsp://192.168.1.2:7447/cameraToken12345");
  assert.equal(g2.streams.get(`cam-${made.json().id}-sub`), "rtsp://192.168.1.2:7447/tok2");
  const keep = [["rtsps://cam.example:322/x?enableSrtp", "other port"], ["rtsps://192.168.1.2:7441/tok?other=1", "other query"], ["rtsp://192.168.1.2:7441/tok", "already plain"], ["https://h:7441/tok?enableSrtp", "not rtsps"]];
  const made2: string[] = [];
  for (const [src, why] of keep) {
    const r = await call("POST", "/api/cameras", { name: "k", main: src });
    assert.equal(r.json().converted, false, why);
    assert.equal(g2.streams.get(`cam-${r.json().id}`), src, why);
    made2.push(r.json().id);
  }
  const authed = await call("POST", "/api/cameras", { name: "Door", main: "rtsps://admin:pw@10.0.0.5:7441/abc?enableSrtp" });
  assert.equal(g2.streams.get(`cam-${authed.json().id}`), "rtsp://admin:pw@10.0.0.5:7447/abc");
  for (const id of [made.json().id, authed.json().id, ...made2]) await call("DELETE", `/api/cameras/${id}`);
});

test("cameras: the Test button gives a picture or a plain-language reason, and leaves nothing behind", async () => {
  const test = (body: object) => call("POST", "/api/cameras/test", body);
  const ok = (await test({ main: "rtsp://admin:pw@192.168.1.20:554/s1" })).json().results[0];
  assert.deepEqual([ok.which, ok.ok], ["main", true]); assert.match(ok.image, /^data:image\/jpeg;base64,/);
  const bad = (await test({ main: "rtsp://admin:topsecret@badcam.local/s1" })).json();
  assert.equal(bad.results[0].ok, false); assert.match(bad.results[0].message, /No answer from the camera/);
  assert.ok(!JSON.stringify(bad).includes("topsecret") && !JSON.stringify(bad).includes("badcam.local"), "the address and password are never echoed");
  const auth = (await test({ main: "rtsp://admin:pw@authfail.local/s1" })).json().results[0];
  assert.match(auth.message, /username or password/);
  const both = (await test({ main: "rtsps://192.168.1.2:7441/tok?enableSrtp", sub: "rtsp://admin:pw@192.168.1.20/s2" })).json().results;
  assert.deepEqual(both.map((r: any) => [r.which, r.ok]), [["main", true], ["sub", true]]);
  assert.equal([...g2.streams.keys()].filter(k => k.startsWith("hbtest-")).length, 0, "throwaway test streams are removed");
  for (const evil of ["exec:rm -rf /", "file:///etc/passwd", ""]) assert.equal((await test({ main: evil })).statusCode, 400, evil);
  // Editing a saved camera: the masked password is restored before testing.
  const saved = (await call("POST", "/api/cameras", { name: "T", main: "rtsp://admin:s3cret@badcam.local/x" })).json().id;
  const masked = (await call("GET", `/api/cameras/${saved}`)).json();
  const viaMask = (await test({ cameraId: saved, main: masked.main })).json();
  assert.match(viaMask.results[0].message, /No answer/); assert.ok(!JSON.stringify(viaMask).includes("s3cret"));
  await call("DELETE", `/api/cameras/${saved}`);
  const anon = cookie; cookie = viewerCookie;
  assert.equal((await test({ main: "rtsp://a/b" })).statusCode, 403, "viewers cannot probe your network");
  cookie = anon;
});

test("cameras: import from UniFi Protect uses the converted plain addresses, skips duplicates and failures", async () => {
  const protect = await mockUnifi();
  try {
    const pid = (await call("POST", "/api/integrations", { type: "unifi-protect", name: "Protect", url: protect.url, apiKey: KEY })).json().id;
    const list = (await call("GET", `/api/protect/${pid}/cameras`)).json();
    assert.deepEqual(list.map((c: any) => [c.id, c.name]), [["c1", "Front"], ["c2", "Back"], ["c3", "Drive"]]);
    const run = (await call("POST", `/api/protect/${pid}/import`, { ids: ["c1", "c2", "c3", "nope", "../x"] })).json();
    assert.deepEqual(run.created.map((c: any) => c.name).sort(), ["Drive", "Front"]);
    const front = run.created.find((c: any) => c.name === "Front").id;
    assert.equal(g2.streams.get(`cam-${front}`), "rtsp://192.168.1.1:7447/tokHigh1");
    assert.equal(g2.streams.get(`cam-${front}-sub`), "rtsp://192.168.1.1:7447/tokLow1");
    assert.deepEqual(run.skipped.map((s: any) => s.name).sort(), ["../x".slice(0, 20), "Back", "nope"].sort());
    const again = (await call("POST", `/api/protect/${pid}/import`, { ids: ["c1", "c3"] })).json();
    assert.equal(again.created.length, 0); assert.ok(again.skipped.every((s: any) => /Already added/.test(s.reason)));
    assert.equal((await call("POST", `/api/protect/${pid}/import`, { ids: [] })).statusCode, 400);
    assert.equal((await call("GET", `/api/protect/${(await call("GET", "/api/integrations")).json().find((i: any) => i.type !== "unifi-protect").id}/cameras`)).statusCode, 404, "only Protect connections");
    assert.ok(!JSON.stringify((await call("GET", "/api/cameras")).json()).includes("tokHigh1"), "tokens never reach viewers");
    for (const c of run.created) await call("DELETE", `/api/cameras/${c.id}`);
    await call("DELETE", `/api/integrations/${pid}`);
  } finally { await protect.close(); }
});

test("cameras: only safe sources, passwords hidden, synced to go2rtc, orphan cleanup", async () => {
  for (const evil of ["exec:rm -rf /", "ffmpeg:x#video=h264", "file:///etc/passwd", "rtsp://ok host/x"]) {
    assert.equal((await call("POST", "/api/cameras", { name: "x", main: evil })).statusCode, 400, evil);
  }
  const created = await call("POST", "/api/cameras", { name: "Front Door", main: "rtsp://admin:s3cret@192.168.1.20:554/stream1", sub: "rtsp://admin:s3cret@192.168.1.20:554/stream2" });
  assert.equal(created.statusCode, 200);
  const id = created.json().id;
  assert.equal(g2.streams.get(`cam-${id}`), "rtsp://admin:s3cret@192.168.1.20:554/stream1");
  assert.equal(g2.streams.get(`cam-${id}-sub`), "rtsp://admin:s3cret@192.168.1.20:554/stream2");

  const anon = cookie; cookie = viewerCookie;
  const publicList = (await call("GET", "/api/cameras")).json();
  assert.deepEqual(publicList, [{ id, name: "Front Door" }]);
  assert.equal((await call("GET", `/api/cameras/${id}`)).statusCode, 403);
  cookie = anon;
  const masked = (await call("GET", `/api/cameras/${id}`)).json();
  assert.equal(masked.main, "rtsp://admin:••••@192.168.1.20:554/stream1");
  assert.ok(!(await call("GET", `/api/dashboard`)).body.includes("s3cret"));
  assert.ok(!readFileSync(join(dir, "homebase.db")).includes(Buffer.from("s3cret")), "camera password must be encrypted in the database");

  // Saving the form with the mask still in place keeps the real password.
  await call("PUT", `/api/cameras/${id}`, { name: "Front Door 2", main: masked.main, sub: masked.sub });
  assert.equal(g2.streams.get(`cam-${id}`), "rtsp://admin:s3cret@192.168.1.20:554/stream1");

  // Dashboard referencing the camera keeps it; removing the tile only deletes it after the grace period.
  const dash = (await call("GET", "/api/dashboard")).json();
  const tabs = structuredClone(dash.tabs);
  tabs[0].groups[0].tiles.push({ id: "cam1", type: "camera", w: 2, h: 2, config: { cameraId: id } });
  const withCam = await call("PUT", "/api/dashboard", { tabs, baseRevision: dash.revision });
  assert.equal(withCam.statusCode, 200);
  tabs[0].groups[0].tiles.pop();
  await call("PUT", "/api/dashboard", { tabs, baseRevision: withCam.json().revision });
  assert.ok(g2.streams.has(`cam-${id}`), "new unreferenced cameras survive the grace period");
  ctx.db.prepare("UPDATE cameras SET created_at = ? WHERE id = ?").run(Date.now() - 3600_000, id);
  const again = (await call("GET", "/api/dashboard")).json();
  await call("PUT", "/api/dashboard", { tabs, baseRevision: again.revision });
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!g2.streams.has(`cam-${id}`), "orphan camera removed from go2rtc");
  assert.equal((await call("GET", "/api/cameras")).json().length, 0);
});

test("go2rtc reconcile re-adds streams the relay lost and ignores hand-made ones", async () => {
  const id = (await call("POST", "/api/cameras", { name: "Yard", main: "rtsp://10.0.0.5/live" })).json().id;
  g2.streams.clear(); g2.streams.set("my-own-stream", "rtsp://manual");
  await ctx.go2rtc.reconcile();
  assert.ok(g2.streams.has(`cam-${id}`) && g2.streams.has(`cam-${id}-sub`));
  assert.ok(g2.streams.has("my-own-stream"), "streams not created by Homebase are left alone");
  assert.equal(g2.streams.get(`cam-${id}-sub`), "rtsp://10.0.0.5/live", "no sub-stream falls back to the main one");
});

test("go2rtc proxy exposes playback only, and only for Homebase stream names", async () => {
  const id = (await call("GET", "/api/cameras")).json()[0].id;
  const anon = cookie; cookie = viewerCookie;
  const player = await call("GET", `/go2rtc/stream.html?src=cam-${id}`);
  assert.equal(player.statusCode, 200); assert.match(player.body, /player/);
  assert.equal((await call("GET", `/go2rtc/api/frame.jpeg?src=cam-${id}-sub`)).statusCode, 200);
  for (const blocked of ["/go2rtc/api/config", "/go2rtc/api/streams", "/go2rtc/api/streams?src=cam-x", "/go2rtc/stream.html?src=exec:id", "/go2rtc/api/frame.jpeg?src=rtsp://evil", "/go2rtc/stream.html", "/go2rtc/%2e%2e/api/config"]) {
    assert.equal((await call("GET", blocked)).statusCode, 404, blocked);
  }
  assert.ok([403, 404].includes((await call("PUT", "/go2rtc/api/streams?name=x&src=exec:id")).statusCode));
  assert.ok([403, 404].includes((await call("DELETE", "/go2rtc/api/streams?src=cam-x")).statusCode));
  cookie = anon;
  assert.equal((await call("PUT", "/go2rtc/api/streams?name=x&src=exec:id")).statusCode, 404);
  assert.equal((await call("DELETE", "/go2rtc/api/streams?src=cam-x")).statusCode, 404);
  cookie = viewerCookie;
  assert.ok(!g2.hits.some(h => h.includes("exec:")), "blocked requests never reach go2rtc");
  cookie = anon;
});

test("icons: uploads are validated by content, served sandboxed, and require sign-in", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const form = (name: string, data: Buffer, type: string) => {
    const boundary = "----hb";
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  };
  const upload = (name: string, data: Buffer, type: string) => { const f = form(name, data, type); return ctx.app.inject({ method: "POST", url: "/api/icons/upload", payload: f.body, headers: { ...H, ...f.headers, ...(cookie ? { cookie } : {}) } }); };

  const ok = await upload("a.png", png, "image/png");
  assert.equal(ok.statusCode, 200);
  const id = ok.json().id as string;
  assert.match(id, /^[a-f0-9]{24}\.png$/);
  const fake = await upload("evil.png", Buffer.from("<html><script>alert(1)</script></html>"), "image/png");
  assert.equal(fake.statusCode, 400);
  const svg = await upload("x.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml");
  assert.equal(svg.statusCode, 200);
  const served = await ctx.app.inject({ method: "GET", url: `/icons/${svg.json().id}` });
  assert.equal(served.headers["content-type"], "image/svg+xml");
  assert.match(String(served.headers["content-security-policy"]), /sandbox/);
  assert.equal(served.headers["x-content-type-options"], "nosniff");
  assert.equal((await ctx.app.inject({ method: "GET", url: "/icons/..%2f..%2fsecret.key" })).statusCode, 404);
  const anon = cookie; cookie = viewerCookie;
  assert.equal((await upload("a.png", png, "image/png")).statusCode, 403);
  cookie = anon;
  assert.ok(readdirSync(join(dir, "icons")).length === 2);
});

test("server-sent events deliver current snapshots to a new viewer", async () => {
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (ctx.app.server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { cookie } });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  let text = "";
  const deadline = Date.now() + 3000;
  while (!text.includes(sabId) && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, /event: snapshot/);
  assert.ok(text.includes(sabId));
  assert.ok(!text.includes(KEY));
});
