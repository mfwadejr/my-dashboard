import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import { judgeFrameHeaders } from "../src/openaddr.js";
import { KEY, mockSonarr } from "./mocks.js";

process.env.NODE_ENV = "test";
const H = { "x-homebase": "1" };
type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx, admin = "", sonarr: Awaited<ReturnType<typeof mockSonarr>>, pages: Server, base = "";
const cookieOf = (res: { headers: Record<string, any> }) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).map(c => c.split(";")[0])[0] ?? "";
const call = (method: string, url: string, payload?: unknown) => ctx.app.inject({ method: method as any, url, payload: payload as any, headers: { ...H, cookie: admin, host: "hb.local:3000" } });

before(async () => {
  sonarr = await mockSonarr();
  pages = createServer((req, res) => {
    const h: Record<string, string> = { "content-type": "text/html" };
    if (req.url === "/deny") h["x-frame-options"] = "DENY";
    if (req.url === "/csp-none") h["content-security-policy"] = "default-src 'self'; frame-ancestors 'none'";
    if (req.url === "/csp-home") h["content-security-policy"] = "frame-ancestors http://hb.local:3000";
    if (req.url === "/redirect") { res.writeHead(302, { location: "/deny" }); return res.end(); }
    res.writeHead(200, h); res.end("<html></html>");
  });
  await new Promise<void>(r => pages.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(pages.address() as any).port}`;
  ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "homebase-open-")), port: 0, host: "127.0.0.1", go2rtcUrl: null, webDir: "/nonexistent", trustProxy: false, startPollers: false, publicPort: 0 });
  admin = cookieOf(await ctx.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "boss", password: "correct horse battery" }, headers: H }));
});
after(async () => { await ctx.app.close(); await sonarr.close(); await new Promise(r => pages.close(r)); });

test("a connection can carry a separate open address and open mode; they are validated and listed", async () => {
  const make = (extra: object) => call("POST", "/api/integrations", { type: "sonarr", name: "Main", url: sonarr.url, apiKey: KEY, ...extra });
  assert.equal((await make({ openUrl: "ftp://x" })).statusCode, 400);
  assert.equal((await make({ openUrl: "https://user:pw@x.example" })).statusCode, 400);
  assert.equal((await make({ openUrl: "not an address" })).statusCode, 400);
  const id = (await make({ openUrl: "https://sonarr.example.com/tv?a=1", openMode: "inapp" })).json().id;
  const one = () => call("GET", "/api/integrations").then(r => r.json().find((i: any) => i.id === id));
  assert.equal((await one()).openUrl, "https://sonarr.example.com/tv?a=1"); assert.equal((await one()).openMode, "inapp");
  const put = await call("PUT", `/api/integrations/${id}`, { name: "Main", url: sonarr.url, openUrl: "", openMode: "bogus" });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await one()).openUrl, ""); assert.equal((await one()).openMode, "tab");
  await call("DELETE", `/api/integrations/${id}`);
});

test("header rules decide whether an app may be shown inside Homebase", () => {
  const home = new URL("http://hb.local:3000"), t = new URL("http://app.local");
  assert.equal(judgeFrameHeaders({}, t, home).embeddable, true);
  assert.equal(judgeFrameHeaders({ "x-frame-options": "DENY" }, t, home).embeddable, false);
  assert.equal(judgeFrameHeaders({ "x-frame-options": "SAMEORIGIN" }, t, home).embeddable, false);
  assert.equal(judgeFrameHeaders({ "content-security-policy": "frame-ancestors *" }, t, home).embeddable, true);
  assert.equal(judgeFrameHeaders({ "content-security-policy": "frame-ancestors 'self' http://hb.local:3000" }, t, home).embeddable, true);
  assert.equal(judgeFrameHeaders({ "content-security-policy": "frame-ancestors 'none'" }, t, home).embeddable, false);
  assert.equal(judgeFrameHeaders({ "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "" }, t, home).embeddable, false);
  assert.match(judgeFrameHeaders({}, t, new URL("https://hb.example.com")).reason, /https/, "an http page cannot sit inside an https one");
});

test("frame-check asks the app, follows redirects, and only visits addresses Homebase has saved", async () => {
  const id = (await call("POST", "/api/integrations", { type: "sonarr", name: "A", url: sonarr.url, apiKey: KEY, openUrl: `${base}/ok`, openMode: "inapp" })).json().id;
  const check = (u: string) => call("GET", `/api/frame-check?url=${encodeURIComponent(u)}`);
  assert.deepEqual((await check(`${base}/ok`)).json(), { embeddable: true, reason: "" });
  assert.equal((await check("http://169.254.169.254/")).statusCode, 404, "an address Homebase has not saved is never visited");
  assert.equal((await check("nonsense")).statusCode, 400);
  for (const [path, want] of [["/deny", false], ["/csp-none", false], ["/csp-home", true], ["/redirect", false]] as const) {
    await call("PUT", `/api/integrations/${id}`, { name: "A", url: sonarr.url, openUrl: `${base}${path}`, openMode: "inapp" });
    assert.equal((await check(`${base}${path}`)).json().embeddable, want, path);
  }
  await call("PUT", `/api/integrations/${id}`, { name: "A", url: sonarr.url, openUrl: "http://127.0.0.1:1/", openMode: "inapp" });
  const down = (await check("http://127.0.0.1:1/")).json();
  assert.equal(down.embeddable, false); assert.match(down.reason, /could not reach/);
  // a Launcher link in the dashboard is also known
  const dash = (await call("GET", "/api/dashboard")).json();
  dash.tabs[0].groups[0].tiles.push({ id: "l1", type: "launcher", w: 3, h: 2, config: { items: [{ id: "i1", name: "Wiki", url: `${base}/ok?x=1` }] } });
  assert.equal((await call("PUT", "/api/dashboard", { tabs: dash.tabs, baseRevision: dash.revision })).statusCode, 200);
  assert.equal((await check(`${base}/ok?x=1`)).json().embeddable, true);
});

test("the open address and mode survive a backup and restore", async () => {
  const id = (await call("POST", "/api/integrations", { type: "sonarr", name: "Keep", url: sonarr.url, apiKey: KEY, openUrl: "https://keep.example.com/", openMode: "inapp" })).json().id;
  const file = (await call("POST", "/api/backup/export", {})).json();
  const mine = file.integrations.find((i: any) => i.id === id);
  assert.equal(mine.openUrl, "https://keep.example.com/"); assert.equal(mine.openMode, "inapp");
  await call("DELETE", `/api/integrations/${id}`);
  const r = await call("POST", "/api/backup/import", { file, mode: "merge" });
  assert.equal(r.statusCode, 200, r.body);
  const back = (await call("GET", "/api/integrations")).json().find((i: any) => i.id === id);
  assert.equal(back.openUrl, "https://keep.example.com/"); assert.equal(back.openMode, "inapp");
});
