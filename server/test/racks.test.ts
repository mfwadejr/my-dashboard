import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";

process.env.NODE_ENV = "test";
const H = { "x-homebase": "1" };
let ctx: Awaited<ReturnType<typeof buildApp>>, admin = "", viewer = "";
const cookieOf = (res: { headers: Record<string, any> }) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).map(c => c.split(";")[0])[0] ?? "";
const raw = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => ctx.app.inject({ method: method as any, url, payload: payload as any, headers });
const call = (method: string, url: string, payload?: unknown, cookie = admin) => raw(method, url, payload, { ...H, ...(cookie ? { cookie } : {}) });

before(async () => {
  ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "homebase-rack-")), port: 0, host: "127.0.0.1", go2rtcUrl: null, webDir: join(tmpdir(), "none"), trustProxy: false, startPollers: false, publicPort: 0 });
  admin = cookieOf(await raw("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery" }, H));
  await call("POST", "/api/users", { username: "look", password: "viewer password 1", role: "viewer" });
  viewer = cookieOf(await raw("POST", "/api/auth/login", { username: "look", password: "viewer password 1" }, H));
});
after(async () => { await ctx.app.close(); });

const rack = async (body: object = {}) => (await call("POST", "/api/racks", { name: "Main", units: 42, ...body })).json();
const put = async (rid: string, body: object) => call("POST", `/api/racks/${rid}/devices`, body);

test("racks: size limits and the height can be changed", async () => {
  assert.equal((await call("POST", "/api/racks", { name: "", units: 42 })).statusCode, 400);
  assert.equal((await call("POST", "/api/racks", { name: "x", units: 0 })).statusCode, 400);
  assert.equal((await call("POST", "/api/racks", { name: "x", units: 61 })).statusCode, 400);
  const r = await rack({ units: 42, width: 10, topDown: true });
  assert.deepEqual([r.units, r.width, r.topDown], [42, 10, true]);
  const small = (await call("PUT", `/api/racks/${r.id}`, { units: 12 })).json();
  assert.equal(small.units, 12);
  assert.equal(small.width, 10, "unchanged fields stay");
});

test("devices: positions, overlaps, front and rear sharing", async () => {
  const r = await rack({ units: 10 });
  const a = (await put(r.id, { name: "Switch", kind: "switch", units: 2, slot: 5, ports: 24 })).json();
  assert.deepEqual([a.slot, a.units, a.face], [5, 2, "both"]);
  assert.equal((await put(r.id, { name: "Clash", units: 1, slot: 6 })).statusCode, 400, "overlap on the same faces");
  assert.equal((await put(r.id, { name: "Next", units: 1, slot: 7 })).statusCode, 200, "touching is fine");
  assert.equal((await put(r.id, { name: "Too tall", units: 3, slot: 9 })).statusCode, 400, "sticks out of the top");
  assert.equal((await put(r.id, { name: "Too many", units: 11, slot: 1 })).statusCode, 400);
  // half-depth devices on opposite faces can share units
  const f = await put(r.id, { name: "Front shelf", units: 1, slot: 1, face: "front" });
  assert.equal(f.statusCode, 200);
  assert.equal((await put(r.id, { name: "Rear PDU", units: 1, slot: 1, face: "rear" })).statusCode, 200);
  assert.equal((await put(r.id, { name: "Front again", units: 1, slot: 1, face: "front" })).statusCode, 400);
  assert.equal((await put(r.id, { name: "Both", units: 1, slot: 1, face: "both" })).statusCode, 400);
  // moving a device onto another is refused, onto free space works, and moving itself over its own old spot is fine
  const moved = await call("PUT", `/api/racks/devices/${a.id}`, { slot: 4 });
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.json().slot, 4);
  assert.equal((await call("PUT", `/api/racks/devices/${a.id}`, { slot: 6 })).statusCode, 400);
  assert.equal((await put(r.id, { name: "Bad colour", units: 1, slot: 10, color: "9" })).statusCode, 400);
  assert.equal((await put(r.id, { name: "Bad kind", units: 1, slot: 10, kind: "toaster" })).statusCode, 400);
});

test("racks: shrinking below a placed device is refused; deleting removes devices", async () => {
  const r = await rack({ units: 20 });
  await put(r.id, { name: "High", units: 2, slot: 15 });
  const refused = await call("PUT", `/api/racks/${r.id}`, { units: 10 });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /U16/);
  assert.equal((await call("PUT", `/api/racks/${r.id}`, { units: 16 })).statusCode, 200);
  assert.equal((await call("DELETE", `/api/racks/${r.id}`)).statusCode, 200);
  const left = (await call("GET", "/api/racks")).json().items.find((x: any) => x.id === r.id);
  assert.equal(left, undefined);
  assert.equal(ctx.deps.db.prepare("SELECT COUNT(*) AS n FROM rack_devices WHERE rack_id = ?").get(r.id)!.n, 0);
});

test("racks: viewers can look but not change, and never see notes", async () => {
  const r = await rack({ notes: "key in the drawer" });
  const d = (await put(r.id, { name: "NAS", units: 2, slot: 3, notes: "serial 1234", watts: 80 })).json();
  assert.equal((await call("POST", "/api/racks", { name: "Nope" }, viewer)).statusCode, 403);
  assert.equal((await call("PUT", `/api/racks/devices/${d.id}`, { slot: 9 }, viewer)).statusCode, 403);
  assert.equal((await call("DELETE", `/api/racks/devices/${d.id}`, undefined, viewer)).statusCode, 403);
  const seen = (await call("GET", "/api/racks", undefined, viewer)).json().items.find((x: any) => x.id === r.id);
  assert.equal(seen.devices[0].name, "NAS");
  assert.ok(!JSON.stringify(seen).includes("serial 1234") && !JSON.stringify(seen).includes("key in the drawer"));
  const mine = (await call("GET", "/api/racks")).json().items.find((x: any) => x.id === r.id);
  assert.equal(mine.devices[0].notes, "serial 1234");
  assert.equal((await raw("GET", "/api/racks")).statusCode, 401, "sign-in is required");
});

test("racks: order, device picture and backup round trip", async () => {
  const a = await rack({ name: "A" }), b = await rack({ name: "B" });
  await call("PUT", "/api/racks/order", { ids: [b.id, a.id] });
  const ids = (await call("GET", "/api/racks")).json().items.map((x: any) => x.id);
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
  await put(a.id, { name: "Patch", kind: "patch", units: 1, slot: 40, ports: 24, color: "3", face: "front", width: 10 });
  const file = (await call("POST", "/api/backup/export", {})).json();
  assert.ok(Array.isArray(file.racks) && file.racks.length >= 2);
  const dev = file.racks.find((x: any) => x.id === a.id).devices[0];
  assert.deepEqual([dev.name, dev.slot, dev.face, dev.color, dev.width, dev.ports], ["Patch", 40, "front", "3", 10, 24]);
  // a replace import brings back exactly what the file holds
  await call("DELETE", `/api/racks/${a.id}`);
  const res = await call("POST", "/api/backup/import", { file, mode: "replace" });
  assert.equal(res.statusCode, 200, res.body);
  const back = (await call("GET", "/api/racks")).json().items.find((x: any) => x.id === a.id);
  assert.equal(back.devices[0].name, "Patch");
  // a merge does not duplicate racks that are already there
  await call("POST", "/api/backup/import", { file, mode: "merge" });
  assert.equal((await call("GET", "/api/racks")).json().items.filter((x: any) => x.id === a.id).length, 1);
});

// ---------------------------------------------------------------- pictures and the device library

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const YAML = "manufacturer: Ubiquiti\nmodel: USW-Pro-24-PoE\nu_height: 1\nis_full_depth: false\ninterfaces:\n  - name: Port 1\n    type: 1000base-t\n  - name: Port 2\n    type: 1000base-t\n  - name: SFP 1\n    type: 10gbase-x-sfpp\nconsole-ports:\n  - name: Console\n";

test("library: lists models, saves pictures as own copies, reads height and ports, and rear pictures are kept", async () => {
  let hits: string[] = [];
  const gh: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const u = req.url ?? "";
    const json = (v: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (u === "/api/contents/elevation-images") return json([{ name: "Ubiquiti", type: "dir" }, { name: "Cisco", type: "dir" }, { name: "README.md", type: "file" }]);
    if (u === "/api/contents/elevation-images/Ubiquiti") return json([{ name: "USW-Pro-24-PoE.front.png", type: "file" }, { name: "USW-Pro-24-PoE.rear.png", type: "file" }, { name: "UAP-AC-Pro.front.png", type: "file" }, { name: "notes.txt", type: "file" }]);
    if (u.startsWith("/raw/elevation-images/Ubiquiti/") && u.endsWith(".png")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (u === "/raw/device-types/Ubiquiti/USW-Pro-24-PoE.yaml") { res.writeHead(200); return res.end(YAML); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => gh.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
  process.env.RACK_LIBRARY_API = `${base}/api`; process.env.RACK_LIBRARY_RAW = `${base}/raw`;
  try {
    const mf = (await call("GET", "/api/racks/library/manufacturers")).json().items;
    assert.deepEqual(mf, ["Cisco", "Ubiquiti"]);
    const all = (await call("GET", "/api/racks/library/models?manufacturer=Ubiquiti")).json().items;
    assert.deepEqual(all.map((m: any) => m.id), ["UAP-AC-Pro", "USW-Pro-24-PoE"]);
    const found = (await call("GET", "/api/racks/library/models?manufacturer=Ubiquiti&q=pro 24")).json().items;
    assert.deepEqual(found.map((m: any) => m.id), ["USW-Pro-24-PoE"]);
    assert.equal((await call("GET", "/api/racks/library/models?manufacturer=..%2F..")).statusCode, 400, "folder names are checked");
    assert.equal((await call("GET", "/api/racks/library/manufacturers", undefined, viewer)).statusCode, 403);

    const got = await call("POST", "/api/racks/library/import", { manufacturer: "Ubiquiti", model: "USW-Pro-24-PoE" });
    assert.equal(got.statusCode, 200, got.body);
    const b = got.json();
    assert.deepEqual([b.name, b.units, b.fullDepth, b.ports], ["USW-Pro-24-PoE", 1, false, 3]);
    assert.match(b.front.icon, /^used\//); assert.match(b.rear.icon, /^used\//);
    assert.equal((await call("POST", "/api/racks/library/import", { manufacturer: "Ubiquiti", model: "Nope" })).statusCode, 400);
    const front = (await call("GET", "/api/racks/library/models?manufacturer=Ubiquiti&q=uap")).json().items[0];
    const onlyFront = (await call("POST", "/api/racks/library/import", { manufacturer: "Ubiquiti", model: front.id })).json();
    assert.ok(onlyFront.front && onlyFront.rear === null && onlyFront.units === null, "a model without a rear picture or description still imports");
    assert.ok(hits.filter(h => h === "/api/contents/elevation-images/Ubiquiti").length === 1, "listings are remembered");

    // a device keeps both pictures and the fit choice, and they survive a backup
    const r = await rack({ units: 12 });
    const d = (await put(r.id, { name: "Switch", kind: "switch", units: 1, slot: 5, look: "image", icon: b.front.icon, rearIcon: b.rear.icon, fit: "fill" })).json();
    assert.deepEqual([d.look, d.icon === b.front.icon, d.rearIcon === b.rear.icon, d.fit], ["image", true, true, "fill"]);
    assert.equal((await call("PUT", `/api/racks/devices/${d.id}`, { fit: "weird" })).json().fit, "stretch");
    const file = (await call("POST", "/api/backup/export", {})).json();
    const inFile = file.racks.find((x: any) => x.id === r.id).devices[0];
    assert.equal(inFile.rearIcon, b.rear.icon);
    assert.ok(file.icons[b.rear.icon.split("?")[0]], "the rear picture travels inside the backup");
  } finally { gh.close(); delete process.env.RACK_LIBRARY_API; delete process.env.RACK_LIBRARY_RAW; }
});

test("draw.io pictures are cleaned and saved", async () => {
  const { cleanDrawio } = await import("../src/racklibrary.js");
  const { svgIsSafe } = await import("../src/icons.js");
  const raw = `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "x" "y"><svg xmlns="http://www.w3.org/2000/svg" width="1906px" height="173px"><rect fill="light-dark(rgb(1, 2, 3), var(--a, #121212))" style="stroke: light-dark(#fff, #000);"/><switch><foreignObject><div>1</div></foreignObject><a xlink:href="https://x.example"><text>no</text></a></switch></svg>`;
  const out = cleanDrawio(raw);
  assert.ok(svgIsSafe(out));
  assert.ok(!out.includes("light-dark") && !out.includes("foreignObject") && !out.includes("DOCTYPE"));
  assert.ok(out.includes('fill="rgb(1, 2, 3)"') && out.includes("stroke: #fff;"));
});

test("draw.io library: lists drawings, saves the cleaned picture, reads the height from its shape", async () => {
  const svg = (h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="1906px" height="${h}px" viewBox="0 0 1906 ${h}"><rect width="10" height="10" fill="light-dark(#fff, #000)"/><switch><foreignObject><div>x</div></foreignObject></switch></svg>`;
  const gh: Server = createServer((req, res) => {
    const u = decodeURI(req.url ?? "");
    if (u === "/api/git/trees/main?recursive=1") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ tree: [
      { path: "SVG Files/Unifi/Switches/Professional/USW-Pro-24-PoE.svg", type: "blob" }, { path: "SVG Files/Unifi/Gateways/UDM-Pro-Max.svg", type: "blob" }, { path: "SVG Files/Unifi/readme.md", type: "blob" }, { path: "README.md", type: "blob" }] })); }
    if (u === "/raw/SVG Files/Unifi/Switches/Professional/USW-Pro-24-PoE.svg") { res.writeHead(200); return res.end(svg(173)); }
    if (u === "/raw/SVG Files/Unifi/Gateways/UDM-Pro-Max.svg") { res.writeHead(200); return res.end(svg(345)); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => gh.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
  process.env.RACK_DRAWIO_API = `${base}/api`; process.env.RACK_DRAWIO_RAW = `${base}/raw`;
  try {
    assert.deepEqual((await call("GET", "/api/racks/library/manufacturers?source=drawio")).json().items, ["Unifi"]);
    const found = (await call("GET", "/api/racks/library/models?source=drawio&manufacturer=Unifi&q=pro 24")).json().items;
    assert.deepEqual(found.map((m: any) => m.id), ["Switches/Professional/USW-Pro-24-PoE"]);
    const one = await call("POST", "/api/racks/library/import", { source: "drawio", manufacturer: "Unifi", model: "Switches/Professional/USW-Pro-24-PoE" });
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(one.json().units, 1); assert.equal(one.json().name, "USW Pro 24 PoE"); assert.ok(one.json().front.icon.startsWith("used/")); assert.equal(one.json().rear, null);
    const two = (await call("POST", "/api/racks/library/import", { source: "drawio", manufacturer: "Unifi", model: "Gateways/UDM-Pro-Max" })).json();
    assert.equal(two.units, 2);
    assert.equal((await call("POST", "/api/racks/library/import", { source: "drawio", manufacturer: "Unifi", model: "../../etc/passwd" })).statusCode, 400);
  } finally { gh.close(); delete process.env.RACK_DRAWIO_API; delete process.env.RACK_DRAWIO_RAW; }
});
