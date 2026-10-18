import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Access } from "./access.js";
import { claimFirstAdmin, isSetUp } from "./auth.js";
import { AutoBackup } from "./backup.js";
import { installMainGate } from "./gate.js";
import { buildPublicApp } from "./public.js";
import { Shares } from "./shares.js";
import { logEvent } from "./db.js";
import type { Deps } from "./deps.js";
import { versionInfo } from "./version.js";
import { adminRoutes } from "./routes/admin.js";
import { settingsRoutes } from "./routes/settings.js";
import { shareAdminRoutes, shareOpenRoutes } from "./routes/shares.js";
import { userRoutes } from "./routes/users.js";
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
  const shares = new Shares(db, box);
  const access = new Access(db, shares);
  const version = versionInfo();
  const deps: Deps = { config, db, box, store, hub, poller, go2rtc, shares, access, backups: undefined as unknown as AutoBackup };
  deps.backups = new AutoBackup(() => deps, config.dataDir);
  const requireAuth = access.requireAdmin;

  seedIfEmpty(db);
  if (process.env.ADMIN_PASSWORD && !isSetUp(db)) await claimFirstAdmin(db, process.env.ADMIN_USERNAME || "admin", process.env.ADMIN_PASSWORD);

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

  installMainGate(app, deps);
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) { logEvent(db, "error", "system", `Server error on ${request.method} ${request.url.split("?")[0]}: ${error.message}`); app.log.error(error); }
    return reply.code(status).send({ error: status >= 500 ? "Something went wrong on the server" : error.message });
  });

  app.get("/api/health", async () => ({ ok: true, version: version.version }));
  authRoutes(app, deps);
  userRoutes(app, deps);
  settingsRoutes(app, deps);
  shareOpenRoutes(app, deps, false);
  shareAdminRoutes(app, deps);
  adminRoutes(app, deps);
  dashboardRoutes(app, deps);
  integrationRoutes(app, db, store, poller, hub, requireAuth, live, access, version.build);
  iconRoutes(app, icons, requireAuth);
  await cameraRoutes(app, deps);

  if (existsSync(join(config.webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/go2rtc/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }

  const publicApp = config.publicPort && config.publicPort > 0 ? await buildPublicApp(deps) : null;
  if (config.startPollers) {
    poller.start(); go2rtc.start(); deps.backups.start();
    logEvent(db, "info", "system", `Homebase ${version.version} (${version.commit}) started`);
  }
  app.addHook("onClose", async () => { if (publicApp) await publicApp.close(); poller.stop(); live.stop(); go2rtc.stop(); deps.backups.stop(); hub.close(); db.close(); });
  return { app, publicApp, db, store, poller, go2rtc, deps };
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  const config = loadConfig();
  const { app, publicApp } = await buildApp(config);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void app.close().then(() => process.exit(0)));
  await app.listen({ port: config.port, host: config.host });
  if (publicApp) await publicApp.listen({ port: config.publicPort!, host: config.host });
}
