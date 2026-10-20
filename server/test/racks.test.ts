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
