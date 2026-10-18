import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { buildApp } from "../src/index.js";
import { applyIcons, listHolders } from "../src/iconuse.js";
import { migrateLegacyIcons } from "../src/iconmigrate.js";
import { parseDashboardIcons, parseLucide, parseSelfhst } from "../src/icons.js";
import { readTarGz, tarChunks, type TarSource } from "../src/tarstream.js";
import { KEY, mockSonarr } from "./mocks.js";

process.env.NODE_ENV = "test";
const H = { "x-homebase": "1" };
type Ctx = Awaited<ReturnType<typeof buildApp>>;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]);
const svg = (n: string, extra = "") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>${n}</title>${extra}<circle cx="12" cy="12" r="10"/></svg>`);
const lucideSvg = (n: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><title>${n}</title><path d="M2 2h20"/></svg>`);

// What the three "libraries" publish. Tests change `world` to simulate an upstream edit.
const world = {
  plex: svg("plex v1"), evil: svg("evil", "<script>alert(1)</script>"),
  hits: [] as string[]
};
const DI_INDEX = { plex: { base: "svg", aliases: ["media server"], categories: ["media"] }, "plex-dark": { base: "svg" }, sonarr: { base: "svg", aliases: ["tv"] }, photoprism: { base: "png" }, evil: { base: "svg" } };
const SH_INDEX = [
  { Name: "Plex", Reference: "plex", SVG: "Yes", PNG: "Yes", WebP: "Yes", Category: "Media", Tags: "streaming" },
  { Name: "Jellyfin", Reference: "jellyfin", SVG: "Yes", PNG: "Yes", WebP: "Yes", Category: "Media", Tags: "streaming, media server" }
];

async function gz(entries: TarSource[]): Promise<Buffer> {
  const out: Buffer[] = [];
  const g = createGzip(); g.on("data", c => out.push(c));
  await new Promise<void>((res, rej) => { Readable.from(tarChunks(entries, () => Readable.from([]))).pipe(g).on("end", res).on("error", rej); });
  return Buffer.concat(out);
}
const di = (slug: string, fmt: string) => (slug === "plex" && fmt === "svg" ? world.plex : slug === "evil" ? world.evil : fmt === "svg" ? svg(slug) : fmt === "png" ? PNG : WEBP);

function library(): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer(async (req, res) => {
      const path = decodeURIComponent((req.url ?? "").split("?")[0]);
      world.hits.push(path);
      const send = (b: Buffer | string, type = "application/octet-stream") => { res.writeHead(200, { "content-type": type }); res.end(b); };
      if (path === "/dashboard-icons/index.json") return send(JSON.stringify(DI_INDEX), "application/json");
      if (path === "/selfhst/index.json") return send(JSON.stringify(SH_INDEX), "application/json");
      if (path === "/dashboard-icons.tar.gz") {
        const e: TarSource[] = [];
        for (const [slug, m] of Object.entries(DI_INDEX)) for (const f of m.base === "svg" ? ["svg", "png", "webp"] : ["png", "webp"]) e.push({ name: `dashboard-icons-main/${f}/${slug}.${f}`, data: di(slug, f) });
        e.push({ name: "dashboard-icons-main/README.md", data: Buffer.from("hi") });
        return send(await gz(e));
      }
      if (path === "/selfhst.tar.gz") {
        const e: TarSource[] = [];
        for (const m of SH_INDEX) for (const f of ["svg", "png", "webp"]) e.push({ name: `icons-main/${f}/${m.Reference}.${f}`, data: f === "svg" ? svg(`selfhst ${m.Reference}`) : f === "png" ? PNG : WEBP });
        return send(await gz(e));
      }
      if (path === "/lucide.tar.gz") {
        return send(await gz([
          { name: "package/tags.json", data: Buffer.from(JSON.stringify({ camera: ["photo", "security"], wifi: ["wireless", "network"] })) },
          { name: "package/icons/camera.svg", data: lucideSvg("camera") }, { name: "package/icons/wifi.svg", data: lucideSvg("wifi") },
          { name: "package/package.json", data: Buffer.from("{}") }
        ]));
      }
      const m = /^\/(dashboard-icons|selfhst|lucide)\/(svg|png|webp)\/([a-z0-9-]+)\.(svg|png|webp)$/.exec(path);
      if (m) {
        const [, src, fmt, slug] = m;
        if (src === "lucide") return slug === "camera" || slug === "wifi" ? send(lucideSvg(slug)) : (res.writeHead(404), res.end());
        const known = src === "dashboard-icons" ? slug in DI_INDEX : SH_INDEX.some(x => x.Reference === slug);
        if (!known || (fmt !== "svg" && false)) return (res.writeHead(404), res.end());
        return send(src === "dashboard-icons" ? di(slug, fmt) : fmt === "svg" ? svg(`selfhst ${slug}`) : fmt === "png" ? PNG : WEBP);
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

let lib: Awaited<ReturnType<typeof library>>, sonarr: Awaited<ReturnType<typeof mockSonarr>>, ctx: Ctx, dir: string, admin = "", viewer = "", connId = "";
const make = (d: string) => buildApp({ dataDir: d, port: 0, host: "127.0.0.1", go2rtcUrl: null, webDir: join(d, "none"), trustProxy: false, startPollers: false, publicPort: 0 });
const cookieOf = (res: { headers: Record<string, any> }) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).map(c => c.split(";")[0])[0] ?? "";
const raw = (c: Ctx, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => c.app.inject({ method: method as any, url, payload: payload as any, headers });
const call = (method: string, url: string, payload?: unknown, cookie = admin) => raw(ctx, method, url, payload, { ...H, ...(cookie ? { cookie } : {}) });
const form = (name: string, data: Buffer, type = "application/octet-stream") => {
  const b = "----hb";
  return { body: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
};
const upload = (c: Ctx, cookie: string, url: string, name: string, data: Buffer) => { const f = form(name, data); return raw(c, "POST", url, f.body, { ...H, ...f.headers, cookie }); };
const settle = async () => { await ctx.deps.icons.idle(); };

before(async () => {
  lib = await library(); sonarr = await mockSonarr();
  process.env.ICON_SOURCE_BASE = lib.url;
  dir = mkdtempSync(join(tmpdir(), "homebase-icons-"));
  ctx = await make(dir);
  admin = cookieOf(await raw(ctx, "POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, H));
  await call("POST", "/api/users", { username: "wall", password: "viewer password 1", role: "viewer" });
  viewer = cookieOf(await raw(ctx, "POST", "/api/auth/login", { username: "wall", password: "viewer password 1" }, H));
  connId = (await call("POST", "/api/integrations", { type: "sonarr", name: "Main", url: sonarr.url, apiKey: KEY })).json().id;
});
beforeEach(() => { ctx.db.prepare("DELETE FROM throttle").run(); });
after(async () => { await ctx.app.close(); await new Promise(r => lib.server.close(r)); await sonarr.close(); });

// ------------------------------------------------------------------ the tar reader and writer

test("tar: what we write we can read, long names and large files included; real tar archives (GNU and pax) read too", async () => {
  const long = `root/${"a".repeat(60)}/${"b".repeat(60)}/file-with-a-long-name.txt`;
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const archive = await gz([{ name: "root/small.txt", data: Buffer.from("hello") }, { name: long, data: Buffer.from("long") }, { name: "root/big.bin", data: big }, { name: "root/skip.txt", data: Buffer.from("no") }]);
  const dirA = mkdtempSync(join(tmpdir(), "tar-a-"));
  const seen: Record<string, number> = {};
  await readTarGz(Readable.from([archive]), (name, size) => (name.endsWith("big.bin") ? { toFile: join(dirA, "big.bin") } : !name.endsWith("skip.txt") && size < 1000), (name, data) => { seen[name] = data.length; });
  assert.deepEqual(seen, { "root/small.txt": 5, [long]: 4, "root/big.bin": 0 });
  assert.equal(readFileSync(join(dirA, "big.bin")).equals(big), true);

  for (const fmt of ["gnu", "pax", "ustar"]) {
    const src = mkdtempSync(join(tmpdir(), "tar-src-"));
    mkdirSync(join(src, "r", "x".repeat(80)), { recursive: true });
    writeFileSync(join(src, "r", "a.txt"), "A"); writeFileSync(join(src, "r", "x".repeat(80), `${"y".repeat(60)}.txt`), "B");
    const out = join(src, "out.tar.gz");
    const r = spawnSync("tar", ["-czf", out, `--format=${fmt}`, "-C", src, "r"]);
    assert.equal(r.status, 0, String(r.stderr));
    const names: string[] = [];
    await readTarGz(Readable.from([readFileSync(out)]), () => true, (n, d) => { names.push(`${n}=${d.toString()}`); });
    assert.deepEqual(names.sort(), [`r/${"x".repeat(80)}/${"y".repeat(60)}.txt=B`, "r/a.txt=A"].sort(), `format ${fmt}`);
  }
});

test("library lists: each source's own format is understood", () => {
  const di2 = parseDashboardIcons(DI_INDEX);
  assert.deepEqual(di2.find(e => e.slug === "photoprism")!.formats, ["png", "webp"]);
  assert.match(di2.find(e => e.slug === "plex")!.searchText, /media server/);
  const sh = parseSelfhst(SH_INDEX);
  assert.equal(sh.length, 2); assert.match(sh[1].searchText, /streaming/);
  assert.deepEqual(parseLucide(["camera", "Bad Name"], { camera: ["photo"] }).map(e => e.slug), ["camera"]);
});

// ------------------------------------------------------------------ the library, step by step

test("nothing reaches the outside until an administrator has chosen how much to keep", async () => {
  const st = (await call("GET", "/api/icons/status")).json();
  assert.equal(st.reviewed, false); assert.equal(st.ready, false);
  await ctx.deps.icons.tick();
  assert.equal(world.hits.length, 0, "no request was made");
  assert.equal((await call("POST", "/api/icons/pick", { ref: "dashboard-icons:plex" })).statusCode, 409);
  assert.equal((await call("POST", "/api/icons/sync/all")).statusCode, 409);
  // uploads need no library
  assert.equal((await upload(ctx, admin, "/api/icons/upload", "a.png", PNG)).statusCode, 200);
  // viewers cannot use any of it
  assert.equal((await call("GET", "/api/icons/status", undefined, viewer)).statusCode, 403);
  assert.equal((await call("GET", "/api/icons/search?q=plex", undefined, viewer)).statusCode, 403);
});

test("choosing a storage option builds the searchable list; search ranks, merges and hides variants", async () => {
  assert.equal((await call("PUT", "/api/settings", { iconTier: "bogus" })).statusCode, 400);
  const saved = (await call("PUT", "/api/settings", { iconTier: "cached" })).json();
  assert.equal(saved.iconReviewed, true);
  await settle();
  const st = (await call("GET", "/api/icons/status")).json();
  assert.equal(st.ready, true); assert.equal(st.tier, "cached");
  const by = Object.fromEntries(st.sources.map((s: any) => [s.id, s]));
  assert.equal(by["dashboard-icons"].indexed, 5); assert.equal(by.selfhst.indexed, 2); assert.equal(by.lucide.indexed, 2);
  assert.equal(by["dashboard-icons"].mirrored, 0, "a cache tier keeps no mirror");
  assert.ok(by.lucide.indexAt && !by.lucide.error);

  const hits = (q: string) => call("GET", `/api/icons/search?q=${encodeURIComponent(q)}`).then(r => r.json() as Array<{ ref: string; label: string; source: string; preview: string }>);
  const plex = await hits("plex");
  assert.equal(plex[0].ref, "dashboard-icons:plex", "the app-logo library wins a shared name");
  assert.ok(!plex.some(h => h.ref === "selfhst:plex"), "no duplicate from the second library");
  assert.ok(!plex.some(h => h.ref.endsWith("plex-dark")), "dark variants stay out of broad search");
  assert.ok((await hits("plex-dark")).some(h => h.ref === "dashboard-icons:plex-dark"), "…but an exact name finds them");
  assert.equal((await hits("media server")).length >= 2, true, "aliases and tags are searched, every word must match");
  assert.deepEqual((await hits("camera")).map(h => h.ref), ["lucide:camera"]);
  assert.deepEqual((await hits("p")).length, 0, "needs two letters");
  assert.deepEqual(await hits("%"), [], "wildcards are not special");
  assert.match(plex[0].preview, /^\/api\/icons\/preview\/dashboard-icons\/plex/);
});

test("previews come through this server, are checked, cached locally, and lucide is recolored for dark", async () => {
  world.hits.length = 0;
  const a = await call("GET", "/api/icons/preview/dashboard-icons/plex");
  assert.equal(a.statusCode, 200); assert.equal(a.headers["content-type"], "image/svg+xml");
  assert.match(String(a.headers["content-security-policy"]), /sandbox/);
  const n = world.hits.length;
  await call("GET", "/api/icons/preview/dashboard-icons/plex");
  assert.equal(world.hits.length, n, "the second look is served from the local cache");
  assert.ok(existsSync(join(dir, "icons", "cache", "dashboard-icons", "plex.svg")));
  const l = (await call("GET", "/api/icons/preview/lucide/camera")).body;
  assert.ok(l.includes("#c7d0de") && !l.includes("currentColor"));
  assert.equal((await call("GET", "/api/icons/preview/dashboard-icons/nope-nope")).statusCode, 404);
  assert.equal((await call("GET", "/api/icons/preview/nowhere/plex")).statusCode, 404);
  assert.equal((await call("GET", "/api/icons/preview/dashboard-icons/..%2fx")).statusCode, 404);
  // a hostile file from a library is refused, not served
  assert.equal((await call("GET", "/api/icons/preview/dashboard-icons/evil")).statusCode, 404);
});

test("picking saves a frozen copy that is served for good, and can be put on a connection, tabs, tiles and Launcher items", async () => {
  const pick = (await call("POST", "/api/icons/pick", { ref: "dashboard-icons:plex" })).json();
  assert.match(pick.icon, /^used\/dashboard-icons-plex\.svg\?v=[a-f0-9]{10}$/); assert.equal(pick.iconRef, "dashboard-icons:plex");
  assert.equal((await call("GET", `/icons/${pick.icon}`, undefined, "")).statusCode, 200);
  assert.equal((await call("POST", "/api/icons/pick", { ref: "dashboard-icons:evil" })).statusCode, 400, "an unsafe icon is refused");
  assert.equal((await call("POST", "/api/icons/pick", { ref: "../../etc/passwd" })).statusCode, 400);
  assert.equal((await call("POST", "/api/icons/pick", { ref: "lucide:nothing" })).statusCode, 400);

  // a connection (admin sets, everyone sees)
  assert.equal((await call("PUT", "/api/icons/assign", { kind: "connection", id: connId, icon: "used/not-saved.svg", iconRef: "" })).statusCode, 400);
  assert.equal((await call("PUT", "/api/icons/assign", { kind: "connection", id: connId, icon: pick.icon, iconRef: pick.iconRef })).statusCode, 200);
  assert.equal((await call("PUT", "/api/icons/assign", { kind: "connection", id: "nope", icon: pick.icon, iconRef: "" })).statusCode, 404);
  assert.equal((await call("PUT", "/api/icons/assign", { kind: "connection", id: connId, icon: pick.icon }, viewer)).statusCode, 403);
  const list = (await call("GET", "/api/integrations", undefined, viewer)).json();
  assert.equal(list[0].icon, pick.icon); assert.equal(list[0].iconRef, "dashboard-icons:plex");

  // tabs, tiles and Launcher items live in the dashboard document; invalid values are dropped
  const dash = (await call("GET", "/api/dashboard")).json(); const doc = { tabs: dash.tabs, baseRevision: dash.revision };
  const lucide = (await call("POST", "/api/icons/pick", { ref: "lucide:camera" })).json();
  doc.tabs[0].icon = pick.icon; doc.tabs[0].iconRef = pick.iconRef;
  doc.tabs[0].groups[0].tiles.push({ id: "launch1", type: "launcher", w: 3, h: 2, config: { icon: lucide.icon, iconRef: lucide.iconRef, items: [{ id: "i1", name: "Plex", url: "http://x", icon: pick.icon, iconRef: pick.iconRef }, { id: "i2", name: "Bad", url: "http://y", icon: "../../etc/passwd", iconRef: "x" }, { id: "i3", name: "Old", url: "http://z", icon: "0123456789abcdef01234567.png" }] } });
  const saved = await call("PUT", "/api/dashboard", doc);
  assert.equal(saved.statusCode, 200, saved.body);
  const tile = saved.json().tabs[0].groups[0].tiles.find((t: any) => t.id === "launch1");
  assert.equal(saved.json().tabs[0].icon, pick.icon);
  assert.equal(tile.config.items[0].icon, pick.icon);
  assert.equal(tile.config.items[1].icon, undefined, "an address that is not a saved file is dropped");
  assert.equal(tile.config.items[2].icon, "0123456789abcdef01234567.png", "older loose files are still understood");
  const holders = listHolders(ctx.db);
  assert.deepEqual(holders.map(h => h.kind).sort(), ["connection", "launcher", "launcher", "tab", "tile"]);
});

test("a library icon that changed upstream shows as an update, and nothing changes until refresh is asked for", async () => {
  assert.equal((await call("GET", "/api/icons/updates")).json().count, 0);
  world.plex = svg("plex v2 — new logo");
  // the cached tier has no list of fingerprints, so look the icons in use up first
  const chk = (await call("POST", "/api/icons/check")).json();
  assert.equal(chk.count, 3, "the connection, the tab and the Launcher item, but not the tile icon from another source");
  assert.ok(chk.items.every((i: any) => i.iconRef === "dashboard-icons:plex"));
  const before = readFileSync(join(dir, "icons", "used", "dashboard-icons-plex.svg"), "utf8");
  assert.match(before, /plex v1/, "the saved copy is frozen");
  const r = (await call("POST", "/api/icons/refresh", { keys: [chk.items[0].key] })).json();
  assert.equal(r.refreshed, 1);
  assert.equal((await call("GET", "/api/icons/updates")).json().count, 2, "only the one asked for was replaced");
  const all = (await call("POST", "/api/icons/refresh")).json();
  assert.equal(all.refreshed, 2);
  assert.match(readFileSync(join(dir, "icons", "used", "dashboard-icons-plex.svg"), "utf8"), /plex v2/);
  assert.equal((await call("GET", "/api/icons/updates")).json().count, 0);
  const tab = (await call("GET", "/api/dashboard")).json().tabs[0];
  assert.match(tab.icon, /dashboard-icons-plex\.svg\?v=[a-f0-9]{10}$/);
});

test("a local mirror keeps one format (or all) on disk, serves from it, and gives the space back when the option is lowered", async () => {
  await call("PUT", "/api/settings", { iconTier: "mirror-single" }); await settle();
  let st = (await call("GET", "/api/icons/status")).json();
  const by = () => Object.fromEntries(st.sources.map((s: any) => [s.id, s]));
  assert.equal(by()["dashboard-icons"].mirrored, 4, "the unsafe one is not kept"); assert.equal(by().selfhst.mirrored, 2); assert.equal(by().lucide.mirrored, 2);
  const m = join(dir, "icons", "mirror");
  assert.ok(existsSync(join(m, "dashboard-icons", "svg", "plex.svg")) && !existsSync(join(m, "dashboard-icons", "png", "plex.png")), "one format per icon");
  assert.ok(existsSync(join(m, "dashboard-icons", "png", "photoprism.png")), "an icon with no svg keeps its best format");
  assert.ok(!existsSync(join(m, "dashboard-icons", "svg", "evil.svg")));
  assert.ok(st.sizes.mirror > 0);
  // served from disk: no requests to the library
  world.hits.length = 0;
  await call("POST", "/api/icons/clear-cache");
  assert.equal((await call("GET", "/api/icons/preview/selfhst/jellyfin")).statusCode, 200);
  assert.equal(world.hits.length, 0);

  await call("PUT", "/api/settings", { iconTier: "mirror-full" }); await settle();
  assert.ok(existsSync(join(m, "dashboard-icons", "png", "plex.png")) && existsSync(join(m, "dashboard-icons", "webp", "plex.webp")), "every format");

  await call("PUT", "/api/settings", { iconTier: "mirror-single" });
  assert.ok(!existsSync(join(m, "dashboard-icons", "png", "plex.png")), "moving to one format drops the extras straight away");
  await settle();

  await call("PUT", "/api/settings", { iconTier: "search" }); await settle();
  assert.ok(!existsSync(m) && !existsSync(join(dir, "icons", "cache")), "search-only keeps nothing in bulk");
  st = (await call("GET", "/api/icons/status")).json();
  assert.equal(by()["dashboard-icons"].mirrored, 0);
  assert.equal((await call("GET", "/api/icons/preview/dashboard-icons/sonarr")).statusCode, 200, "previews still work, fetched each time");
  assert.ok(!existsSync(join(dir, "icons", "cache")));
  await call("PUT", "/api/settings", { iconTier: "cached" }); await settle();
});

test("removed upstream icons stop appearing in search but saved copies keep working", async () => {
  const gone = DI_INDEX as Record<string, unknown>; const keep = gone.sonarr; delete gone.sonarr;
  await ctx.deps.icons.syncSource("dashboard-icons"); await settle();
  assert.equal((await call("GET", "/api/icons/search?q=sonarr")).json().length, 0);
  const st = (await call("GET", "/api/icons/status")).json();
  assert.equal(st.sources.find((s: any) => s.id === "dashboard-icons").removed, 1);
  gone.sonarr = keep;
  await ctx.deps.icons.syncSource("dashboard-icons"); await settle();
  assert.equal((await call("GET", "/api/icons/search?q=sonarr")).json().length, 1, "back upstream, back in search");
});

test("an unreachable library is reported plainly and leaves the old list alone", async () => {
  const saved = process.env.ICON_SOURCE_BASE;
  const dead = new (await import("../src/icons.js")).Icons(ctx.db, dir, { assets: () => ["http://127.0.0.1:9/x"], index: () => "http://127.0.0.1:9/index.json", tarball: async () => "http://127.0.0.1:9/t.tar.gz" });
  const before = (await call("GET", "/api/icons/status")).json().sources.map((s: any) => s.indexed);
  await dead.syncSource("dashboard-icons"); await dead.syncSource("lucide");
  assert.match(dead.state()["dashboard-icons"].error ?? "", /could not be reached/);
  assert.equal(dead.state()["dashboard-icons"].status, "error");
  assert.deepEqual((await call("GET", "/api/icons/status")).json().sources.map((s: any) => s.indexed), before, "the old list is still there");
  process.env.ICON_SOURCE_BASE = saved;
});

test("files nothing uses any more are cleaned up, but fresh ones are given time", async () => {
  const icons = ctx.deps.icons;
  const o = (await call("POST", "/api/icons/pick", { ref: "selfhst:jellyfin" })).json();
  const file = join(dir, "icons", "used", "selfhst-jellyfin.svg");
  assert.ok(existsSync(file));
  assert.equal(icons.gc(new Set()), 0, "just saved: kept for a while");
  const kept = listHolders(ctx.db).map(h => h.icon.split("?")[0]);
  assert.ok(icons.gc(new Set(kept), 0) >= 1, "unused and old enough: removed");
  assert.ok(!existsSync(file));
  assert.ok(existsSync(join(dir, "icons", "used", "dashboard-icons-plex.svg")), "in use: stays");
  void o;
});

// ------------------------------------------------------------------ migration

test("older installs: loose icon files move into icons/used after a verified copy, once, and missing ones are cleared", async () => {
  const id = "a1b2c3d4e5f6a1b2c3d4e5f6.png", gone = "ffffffffffffffffffffffff.png";
  writeFileSync(join(dir, "icons", id), PNG);
  const doc = (await call("GET", "/api/dashboard")).json();
  doc.baseRevision = doc.revision;
  const tile = doc.tabs[0].groups[0].tiles.find((t: any) => t.id === "launch1");
  tile.config.items = [{ id: "m1", name: "Moved", url: "http://a", icon: id }, { id: "m2", name: "Gone", url: "http://b", icon: gone }];
  assert.equal((await call("PUT", "/api/dashboard", doc)).statusCode, 200);

  const r = migrateLegacyIcons(ctx.deps)!;
  assert.equal(r.moved, 1); assert.equal(r.cleared, 1); assert.match(r.copy!, /before-icon-migration\.db$/);
  assert.ok(existsSync(join(dir, "backups", r.copy!)), "the verified copy is in the list");
  assert.ok(existsSync(join(dir, "icons", "used", `upload-${id}`)) && !existsSync(join(dir, "icons", id)));
  const items = (await call("GET", "/api/dashboard")).json().tabs[0].groups[0].tiles.find((t: any) => t.id === "launch1").config.items;
  assert.match(items[0].icon, new RegExp(`^used/upload-${id.replace(".", "\\.")}\\?v=[a-f0-9]{10}$`)); assert.equal(items[1].icon, undefined);
  assert.equal(migrateLegacyIcons(ctx.deps), null, "nothing left to do, nothing touched");
  assert.equal((await call("GET", `/icons/${items[0].icon}`)).statusCode, 200);
});

// ------------------------------------------------------------------ backups carry the icons

test("the backup file bundles the icons it uses; restoring on a fresh install brings them back; verify checks them", async () => {
  const exp = (await call("POST", "/api/backup/export", {})).json();
  const names = Object.keys(exp.icons);
  assert.ok(names.includes("used/dashboard-icons-plex.svg") && names.some(n => n.startsWith("used/upload-")) && names.includes("used/lucide-camera.svg"));
  assert.equal(exp.integrations[0].icon.startsWith("used/dashboard-icons-plex.svg"), true);

  const d2 = mkdtempSync(join(tmpdir(), "homebase-icons2-"));
  const c2 = await make(d2);
  try {
    const a2 = cookieOf(await raw(c2, "POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, H));
    assert.equal(readdirSync(join(d2, "icons", "used")).length, 0);
    const v = (await raw(c2, "POST", "/api/backup/verify-file", undefined, { ...H, cookie: a2 })).statusCode; void v;
    const file = form("b.json", Buffer.from(JSON.stringify(exp)), "application/json");
    const rep = (await raw(c2, "POST", "/api/backup/verify-file", file.body, { ...H, ...file.headers, cookie: a2 })).json();
    assert.equal(rep.checks.find((c: any) => c.id === "icons").status, "pass", JSON.stringify(rep.checks));
    const res = await raw(c2, "POST", "/api/backup/import", { file: exp, mode: "replace" }, { ...H, cookie: a2 });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().result.icons >= 3);
    assert.ok(existsSync(join(d2, "icons", "used", "dashboard-icons-plex.svg")));
    assert.equal((await raw(c2, "GET", `/icons/${exp.integrations[0].icon}`, undefined, {})).statusCode, 200);
    // a hostile bundle: names and bytes are checked, nothing escapes the icons folder
    const evil = { ...exp, icons: { "used/../../secret.svg": svg("x").toString("base64"), "used/bad.svg": Buffer.from("<svg><script>x</script></svg>").toString("base64"), "used/fine.png": PNG.toString("base64") } };
    const r3 = await raw(c2, "POST", "/api/backup/import", { file: evil, mode: "merge" }, { ...H, cookie: a2 });
    assert.equal(r3.statusCode, 200);
    assert.ok(existsSync(join(d2, "icons", "used", "fine.png")) && !existsSync(join(d2, "icons", "used", "bad.svg")) && !existsSync(join(d2, "secret.svg")) && !existsSync(join(d2, "icons", "secret.svg")));
  } finally { await c2.app.close(); }
});

test("a Complete backup carries the database and the icons; verify reads it; adding it restores both; a plain database copy warns about missing icons", async () => {
  const res = await call("GET", "/api/backup/complete");
  assert.equal(res.statusCode, 200); assert.equal(res.headers["content-type"], "application/gzip");
  const archive = res.rawPayload;
  assert.equal(archive[0], 0x1f);
  // what is inside
  const seen: string[] = [];
  await readTarGz(Readable.from([archive]), (n, s) => (n === "homebase.db" ? false : s < 1e6), n => { seen.push(n); });
  assert.ok(seen.includes("manifest.json") && seen.includes("icons/used/dashboard-icons-plex.svg"));

  const rep = (await (async () => { const f = form("c.tar.gz", archive); return raw(ctx, "POST", "/api/backup/verify-file", f.body, { ...H, ...f.headers, cookie: admin }); })()).json();
  assert.equal(rep.kind, "complete"); assert.equal(rep.ok, true, JSON.stringify(rep.checks));
  assert.equal(rep.checks.find((c: any) => c.id === "iconfiles").status, "pass");
  // a damaged archive is refused plainly
  const broken = archive.subarray(0, Math.floor(archive.length / 2));
  const bad = await (async () => { const f = form("c.tar.gz", broken); return raw(ctx, "POST", "/api/backup/verify-file", f.body, { ...H, ...f.headers, cookie: admin }); })();
  assert.equal(bad.statusCode, 400);

  const d2 = mkdtempSync(join(tmpdir(), "homebase-icons3-"));
  const c2 = await make(d2);
  try {
    const a2 = cookieOf(await raw(c2, "POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, H));
    const up = await upload(c2, a2, "/api/backup/snapshots/upload", "c.tar.gz", archive);
    assert.equal(up.statusCode, 200, up.body);
    assert.ok(up.json().icons >= 3 && existsSync(join(d2, "icons", "used", "dashboard-icons-plex.svg")));
    const copy = up.json().name as string;
    assert.ok(existsSync(join(d2, "backups", copy)));
    const v = (await raw(c2, "POST", `/api/backup/snapshots/${copy}/verify`, undefined, { ...H, cookie: a2 })).json();
    assert.equal(v.checks.find((c: any) => c.id === "icons").status, "pass", "the copy's icons are all on this server now");
    // the same database on a server without the icons warns, and says what to do
    const d3 = mkdtempSync(join(tmpdir(), "homebase-icons4-")); const c3 = await make(d3);
    try {
      const a3 = cookieOf(await raw(c3, "POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, H));
      const db = readFileSync(join(d2, "backups", copy));
      const r = (await (async () => { const f = form("x.db", db); return raw(c3, "POST", "/api/backup/verify-file", f.body, { ...H, ...f.headers, cookie: a3 }); })()).json();
      const icons = r.checks.find((c: any) => c.id === "icons");
      assert.equal(icons.status, "warn"); assert.match(icons.detail, /Complete backup/);
      assert.equal(r.restorable, true, "missing icons never block a restore");
    } finally { await c3.app.close(); }
  } finally { await c2.app.close(); }
});

test("API tokens cannot use the icon library, and writes are logged", async () => {
  const tok = (await call("POST", "/api/tokens", { name: "ha", scope: "write" })).json().token as string;
  const b = (method: string, url: string, payload?: unknown) => raw(ctx, method, url, payload, { authorization: `Bearer ${tok}` });
  assert.equal((await b("POST", "/api/icons/pick", { ref: "dashboard-icons:plex" })).statusCode, 403);
  assert.equal((await b("PUT", "/api/icons/assign", { kind: "token", id: "x", icon: "" })).statusCode, 403);
  // a token's own icon is set by an admin
  const id = (await call("GET", "/api/tokens")).json()[0].id as string;
  const p = (await call("POST", "/api/icons/pick", { ref: "lucide:wifi" })).json();
  assert.equal((await call("PUT", "/api/icons/assign", { kind: "token", id, icon: p.icon, iconRef: p.iconRef })).statusCode, 200);
  assert.equal((await call("GET", "/api/tokens")).json()[0].icon, p.icon);
  const people = (await call("GET", "/api/users")).json();
  assert.equal((await call("PUT", "/api/icons/assign", { kind: "account", id: people[0].id, icon: p.icon, iconRef: p.iconRef })).statusCode, 200);
  assert.equal((await call("GET", "/api/users")).json()[0].icon, p.icon);
  assert.equal((await call("PUT", "/api/icons/assign", { kind: "account", id: people[0].id, icon: "" })).statusCode, 200);
  assert.equal((await call("GET", "/api/users")).json()[0].icon, "");
});

test("applyIcons changes several things at once and leaves the rest of the dashboard alone", async () => {
  const before = (await call("GET", "/api/dashboard")).json();
  const n = applyIcons(ctx.db, new Map([["tab:home", { icon: "", iconRef: "" }]]));
  assert.equal(n, 1);
  const after = (await call("GET", "/api/dashboard")).json();
  assert.equal(after.tabs[0].icon, ""); assert.equal(after.revision, before.revision + 1);
  assert.equal(after.tabs[0].groups[0].tiles.length, before.tabs[0].groups[0].tiles.length);
});
