import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Icons } from "../icons.js";
import { readFileSync } from "node:fs";
import { sniffImage } from "../icons.js";

export function iconRoutes(app: FastifyInstance, icons: Icons, requireAuth: preHandlerAsyncHookHandler): void {
  app.get("/api/icons/search", { preHandler: requireAuth }, async (request, reply) => {
    try { return await icons.search(String((request.query as any)?.q ?? "")); }
    catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : "Search failed" }); }
  });

  /** Pick a library icon ({ref:"di:plex"}) or an https image ({url}); it is downloaded and stored locally. */
  app.post("/api/icons/pick", { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as { ref?: string; url?: string };
    try { return { id: await icons.mirror(String(body.ref ?? body.url ?? "")) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Could not save the icon" }); }
  });

  app.post("/api/icons/upload", { preHandler: requireAuth }, async (request, reply) => {
    const file = await request.file({ limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    if (!file) return reply.code(400).send({ error: "No file received" });
    const buf = await file.toBuffer();
    if (file.file.truncated) return reply.code(400).send({ error: "Icons must be 2 MB or smaller" });
    try { return { id: icons.save(buf) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Could not save the icon" }); }
  });

  // Stored icons are public (the dashboard shows them to viewers). The sandbox CSP keeps an uploaded SVG from running anything.
  app.get("/icons/:id", async (request, reply) => {
    const file = icons.path((request.params as { id: string }).id);
    if (!file) return reply.code(404).send({ error: "Not found" });
    const buf = readFileSync(file);
    const kind = sniffImage(buf);
    return reply
      .header("Content-Type", kind?.mime ?? "application/octet-stream")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(buf);
  });
}
