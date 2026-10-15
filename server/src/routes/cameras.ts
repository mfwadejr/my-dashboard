import httpProxy from "@fastify/http-proxy";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { STREAM_NAME, validCameraSource, type Go2rtc } from "../go2rtc.js";
import type { Store } from "../store.js";

function parse(body: any, existing = false) {
  const name = String(body?.name ?? "").trim() || "Camera";
  const main = String(body?.main ?? "").trim();
  const sub = String(body?.sub ?? "").trim();
  if (name.length > 60) throw new Error("The name is too long");
  if (!validCameraSource(main)) throw new Error("The main stream must be an rtsp://, rtsps://, rtmp://, http:// or https:// address");
  if (sub && !validCameraSource(sub)) throw new Error("The sub-stream must be an rtsp://, rtsps://, rtmp://, http:// or https:// address");
  void existing;
  return { name, main, sub };
}

/** Playback paths the browser may reach on go2rtc. Everything else (config, stream management, exec sources) stays blocked. */
const ALLOWED = new Set(["/stream.html", "/video-stream.js", "/video-rtc.js", "/api/ws", "/api/webrtc", "/api/frame.jpeg", "/api/stream.mp4", "/api/stream.m3u8", "/api/hls/playlist.m3u8", "/api/hls/segment.ts", "/api/hls/init.mp4", "/api/hls/segment.m4s"]);

export async function cameraRoutes(app: FastifyInstance, store: Store, go2rtc: Go2rtc, go2rtcUrl: string | null, requireAuth: preHandlerAsyncHookHandler): Promise<void> {
  app.get("/api/cameras", async () => store.listCameras());
  app.get("/api/go2rtc/status", async () => go2rtc.status());

  app.get("/api/cameras/:id", { preHandler: requireAuth }, async (request, reply) => {
    const cam = store.getCameraMasked((request.params as { id: string }).id);
    return cam ?? reply.code(404).send({ error: "Not found" });
  });

  app.post("/api/cameras", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const id = store.createCamera(parse(request.body));
      await go2rtc.upsert(id).catch(() => { /* reported by status; reconcile retries every minute */ });
      return { id };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid camera" }); }
  });

  app.put("/api/cameras/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getCamera(id)) return reply.code(404).send({ error: "Not found" });
    try {
      store.updateCamera(id, parse(request.body, true));
      await go2rtc.upsert(id).catch(() => {});
      return { ok: true };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid camera" }); }
  });

  app.delete("/api/cameras/:id", { preHandler: requireAuth }, async request => {
    const { id } = request.params as { id: string };
    store.deleteCamera(id);
    await go2rtc.remove(id);
    return { ok: true };
  });

  if (!go2rtcUrl) return;
  await app.register(httpProxy, {
    upstream: go2rtcUrl,
    prefix: "/go2rtc",
    rewritePrefix: "",
    websocket: true,
    preHandler: async (request, reply) => {
      const url = new URL(request.url, "http://x");
      const path = url.pathname.replace(/^\/go2rtc/, "") || "/";
      const src = url.searchParams.get("src");
      const okMethod = request.method === "GET" || (request.method === "POST" && path === "/api/webrtc");
      if (!okMethod || !ALLOWED.has(path) || (src !== null && !STREAM_NAME.test(src)) || (src === null && path !== "/video-stream.js" && path !== "/video-rtc.js")) {
        await reply.code(404).send({ error: "Not found" });
      }
    }
  });
}
