import httpProxy from "@fastify/http-proxy";
import type { FastifyInstance } from "fastify";
import { STREAM_NAME, convertUnifiSource, validCameraSource } from "../go2rtc.js";
import type { Deps } from "../deps.js";
import { logEvent } from "../db.js";
import type { FastifyRequest } from "fastify";
import { unmaskUrlSecret } from "../crypto.js";
import { protectCameras, protectStreams } from "../integrations/unifi.js";

function parse(body: any, existing = false) {
  const name = String(body?.name ?? "").trim() || "Camera";
  const mainIn = convertUnifiSource(String(body?.main ?? "").trim()), subIn = convertUnifiSource(String(body?.sub ?? "").trim());
  const main = mainIn.url, sub = subIn.url;
  if (name.length > 60) throw new Error("The name is too long");
  if (!validCameraSource(main)) throw new Error("The main stream must be an rtsp://, rtsps://, rtmp://, http:// or https:// address");
  if (sub && !validCameraSource(sub)) throw new Error("The sub-stream must be an rtsp://, rtsps://, rtmp://, http:// or https:// address");
  void existing;
  return { name, main, sub, converted: mainIn.converted || subIn.converted };
}

/** Playback paths the browser may reach on go2rtc. Everything else (config, stream management, exec sources) stays blocked. */
const ALLOWED = new Set(["/stream.html", "/video-stream.js", "/video-rtc.js", "/api/ws", "/api/webrtc", "/api/frame.jpeg", "/api/stream.mp4", "/api/stream.m3u8", "/api/hls/playlist.m3u8", "/api/hls/segment.ts", "/api/hls/init.mp4", "/api/hls/segment.m4s"]);

/** Who may open a stream: returns null when allowed, or the HTTP status to answer with. */
export type StreamCheck = (request: FastifyRequest, src: string | null) => 401 | 403 | null;

export function mainStreamCheck(d: Deps): StreamCheck {
  return (request, src) => {
    const p = d.access.principal(request);
    if (!p) return 401;
    if (p.kind === "user" || p.share.kind === "kiosk") return null;
    const allowed = new Set(p.share.cameras.flatMap(id => [`cam-${id}`, `cam-${id}-sub`]));
    return src === null || allowed.has(src) ? null : 403;
  };
}

export function publicStreamCheck(d: Deps): StreamCheck {
  return (request, src) => {
    const p = d.access.principal(request, { shareOnly: true });
    if (p?.kind !== "share") return 401;
    const allowed = new Set(p.share.cameras.flatMap(id => [`cam-${id}`, `cam-${id}-sub`]));
    return src === null || allowed.has(src) ? null : 403;
  };
}

/** Live video and pictures come from go2rtc through this narrow window: only playback paths, only camera streams, only for people allowed to see them. */
export async function registerGo2rtcProxy(app: FastifyInstance, go2rtcUrl: string, check: StreamCheck): Promise<void> {
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
        return;
      }
      const verdict = check(request, src);
      if (verdict) await reply.code(verdict).send({ error: verdict === 401 ? "Sign in required" : "Not allowed" });
    }
  });
}

export async function cameraRoutes(app: FastifyInstance, d: Deps): Promise<void> {
  const { store, go2rtc, access, shares, db } = d;
  const requireAuth = access.requireAdmin;
  const go2rtcUrl = d.config.go2rtcUrl;
  app.get("/api/cameras", async () => store.listCameras());
  app.get("/api/go2rtc/status", async () => go2rtc.status());

  // Try an address before saving it: connects through go2rtc and returns one picture when it works.
  app.post("/api/cameras/test", { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const old = typeof body.cameraId === "string" ? store.getCamera(body.cameraId) : undefined;
    const results: Array<{ which: string; ok: boolean; message: string; image?: string }> = [];
    for (const [which, raw, stored] of [["main", body.main, old?.main ?? ""], ["sub", body.sub, old?.sub ?? ""]] as const) {
      const text = String(raw ?? "").trim();
      if (!text) { if (which === "main") return reply.code(400).send({ error: "Enter the main stream address first" }); continue; }
      const src = convertUnifiSource(unmaskUrlSecret(text, stored)).url;
      if (!validCameraSource(src)) return reply.code(400).send({ error: `The ${which} stream must be an rtsp://, rtsps://, rtmp://, http:// or https:// address` });
      results.push({ which, ...(await go2rtc.probe(src)) });
    }
    return { results };
  });

  // Import cameras from a UniFi Protect connection.
  const protectRow = (id: string) => { const row = store.getIntegration(id); return row && row.type === "unifi-protect" ? row : undefined; };
  app.get("/api/protect/:id/cameras", { preHandler: requireAuth }, async (request, reply) => {
    const row = protectRow((request.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: "That is not a UniFi Protect connection" });
    try {
      const list = await protectCameras(store.ctxOf(row));
      return list.map(c => ({ ...c }));
    } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : "Could not list cameras" }); }
  });
  app.post("/api/protect/:id/import", { preHandler: requireAuth }, async (request, reply) => {
    const row = protectRow((request.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: "That is not a UniFi Protect connection" });
    const ids = Array.isArray((request.body as any)?.ids) ? ((request.body as any).ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 30) : [];
    if (!ids.length) return reply.code(400).send({ error: "Choose at least one camera" });
    const ctx = store.ctxOf(row);
    let known;
    try { known = await protectCameras(ctx); } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : "Could not list cameras" }); }
    const existing = new Set(store.listCameras().map(c => store.getCamera(c.id)?.main));
    const created: Array<{ id: string; name: string }> = [], skipped: Array<{ name: string; reason: string }> = [];
    for (const id of ids) {
      const cam = known.find(c => c.id === id);
      if (!cam) { skipped.push({ name: id.slice(0, 20), reason: "Not found on this console" }); continue; }
      try {
        const s = await protectStreams(ctx, id);
        const main = convertUnifiSource(s.main).url, sub = s.sub ? convertUnifiSource(s.sub).url : "";
        if (!validCameraSource(main) || (sub && !validCameraSource(sub))) { skipped.push({ name: cam.name, reason: "Protect returned an address Homebase cannot use" }); continue; }
        if (existing.has(main)) { skipped.push({ name: cam.name, reason: "Already added" }); continue; }
        const newId = store.createCamera({ name: cam.name, main, sub });
        existing.add(main);
        await go2rtc.upsert(newId).catch(() => {});
        created.push({ id: newId, name: cam.name });
      } catch (error) { skipped.push({ name: cam.name, reason: error instanceof Error ? error.message.slice(0, 120) : "Failed" }); }
    }
    if (created.length) logEvent(db, "info", "camera", `${access.actor(request)} imported ${created.length} camera(s) from ${row.name}${skipped.length ? `; ${skipped.length} skipped` : ""}`);
    return { created, skipped };
  });

  app.get("/api/cameras/:id", { preHandler: requireAuth }, async (request, reply) => {
    const cam = store.getCameraMasked((request.params as { id: string }).id);
    return cam ?? reply.code(404).send({ error: "Not found" });
  });

  app.post("/api/cameras", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { converted, ...cam } = parse(request.body);
      const id = store.createCamera(cam);
      logEvent(db, "info", "camera", `${access.actor(request)} added the camera "${cam.name}"`);
      await go2rtc.upsert(id).catch(() => { /* reported by status; reconcile retries every minute */ });
      return { id, converted };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid camera" }); }
  });

  app.put("/api/cameras/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getCamera(id)) return reply.code(404).send({ error: "Not found" });
    try {
      const { converted, ...cam } = parse(request.body, true);
      store.updateCamera(id, cam);
      logEvent(db, "info", "camera", `${access.actor(request)} changed the camera "${cam.name}"`);
      await go2rtc.upsert(id).catch(() => {});
      return { ok: true, converted };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid camera" }); }
  });

  app.delete("/api/cameras/:id", { preHandler: requireAuth }, async request => {
    const { id } = request.params as { id: string };
    const gone = store.getCamera(id);
    store.deleteCamera(id);
    shares.forgetCamera(id);
    await go2rtc.remove(id);
    if (gone) logEvent(db, "info", "camera", `${access.actor(request)} deleted the camera "${gone.name}"`);
    return { ok: true };
  });

  if (go2rtcUrl) await registerGo2rtcProxy(app, go2rtcUrl, mainStreamCheck(d));
}
