import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { claimAdmin, isSetUp, makeRequireAuth } from "./auth.js";
import { loadConfig, type Config } from "./config.js";
import { SecretBox } from "./crypto.js";
import { openDb } from "./db.js";
import { seedIfEmpty } from "./dashboard.js";
import { Go2rtc } from "./go2rtc.js";
import { Hub } from "./hub.js";
import { Icons } from "./icons.js";
import { Poller } from "./poller.js";
import { LiveSampler } from "./live.js";
import { Store } from "./store.js";
import { authRoutes } from "./routes/auth.js";
import { cameraRoutes } from "./routes/cameras.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { iconRoutes } from "./routes/icons.js";
import { integrationRoutes } from "./routes/integrations.js";

export async function buildApp(config: Config) {
  const db = openDb(config.dataDir);
  const box = new SecretBox(config.dataDir);
  const store = new Store(db, box);
  const hub = new Hub();
  const poller = new Poller(db, store, hub);
  const live = new LiveSampler(store);
  const go2rtc = new Go2rtc(config.go2rtcUrl, store, db);
  const icons = new Icons(config.dataDir);
  const requireAuth = makeRequireAuth(db);

  seedIfEmpty(db);
  if (process.env.ADMIN_PASSWORD && !isSetUp(db)) await claimAdmin(db, process.env.ADMIN_PASSWORD);

  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { level: "info" }, trustProxy: config.trustProxy, bodyLimit: 1_000_000 });
  await app.register(cookie);
  await app.register(multipart);

  // Every change request must carry a custom header. A web page on another site cannot add one,
  // which blocks cross-site request forgery on top of the SameSite=Strict session cookie.
  app.addHook("onRequest", async (request, reply) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.url.startsWith("/api/") && request.headers["x-homebase"] !== "1") {
      await reply.code(403).send({ error: "Missing request header" });
    }
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
  });

  app.get("/api/health", async () => ({ ok: true, version: process.env.APP_VERSION ?? "dev" }));
  authRoutes(app, db);
  dashboardRoutes(app, db, store, go2rtc, requireAuth);
  integrationRoutes(app, db, store, poller, hub, requireAuth, live);
  iconRoutes(app, icons, requireAuth);
  await cameraRoutes(app, store, go2rtc, config.go2rtcUrl, requireAuth);

  if (existsSync(join(config.webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/go2rtc/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }

  if (config.startPollers) { poller.start(); go2rtc.start(); }
  app.addHook("onClose", async () => { poller.stop(); live.stop(); go2rtc.stop(); hub.close(); db.close(); });
  return { app, db, store, poller, go2rtc };
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  const config = loadConfig();
  const { app } = await buildApp(config);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void app.close().then(() => process.exit(0)));
  await app.listen({ port: config.port, host: config.host });
}
