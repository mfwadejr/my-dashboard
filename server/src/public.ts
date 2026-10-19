import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { throttleHit } from "./auth.js";
import { publicStreamCheck, registerGo2rtcProxy } from "./routes/cameras.js";
import { shareOpenRoutes } from "./routes/shares.js";
import { statusOpenRoutes } from "./routes/monitors.js";
import type { Deps } from "./deps.js";

/**
 * The only thing that is meant to be reachable from the internet: a second server that answers the share page,
 * the share API and camera playback for camera links, and nothing else. Even if your reverse proxy is set up
 * too widely, there is no admin screen, sign-in or dashboard data on this port.
 */
export async function buildPublicApp(d: Deps) {
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { level: "warn" }, trustProxy: d.config.trustProxy, bodyLimit: 20_000 });
  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    // The app's front page has no business here: the only page this port serves is a share link.
    if (path === "/" || path === "/index.html") return reply.code(404).send({ error: "Not found" });
    // Cheap overall limit per address so the share page cannot be used to hammer the server.
    if (!path.startsWith("/go2rtc/") && !throttleHit(d.db, `pub:${request.ip}`, 600, 60_000)) return reply.code(429).send({ error: "Too many requests" });
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.headers["x-homebase"] !== "1") return reply.code(403).send({ error: "Missing request header" });
  });
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (!reply.getHeader("Cache-Control")) reply.header("Cache-Control", request.url.startsWith("/assets/") ? "public, max-age=3600" : "no-store");
    if (request.protocol === "https") reply.header("Strict-Transport-Security", "max-age=15552000");
    // The camera player pages come from go2rtc and carry their own scripts, so only our own pages get the strict policy.
    if (!request.url.startsWith("/go2rtc/")) {
      reply.header("X-Frame-Options", "DENY");
      reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    }
  });

  app.get("/api/health", async () => ({ ok: true }));
  shareOpenRoutes(app, d, true);
  statusOpenRoutes(app, d);
  if (d.config.go2rtcUrl) await registerGo2rtcProxy(app, d.config.go2rtcUrl, publicStreamCheck(d));

  if (existsSync(join(d.config.webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: d.config.webDir, wildcard: false, cacheControl: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && /^\/(?:s|status)\/[A-Za-z0-9_-]{20,80}\/?$/.test(request.url.split("?")[0])) return reply.header("Cache-Control", "no-store").sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "Not found" }));
  }
  return app;
}
