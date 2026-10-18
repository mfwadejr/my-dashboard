import { readFileSync, rmSync } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { throttleHit } from "../auth.js";
import { logEvent } from "../db.js";
import type { Deps } from "../deps.js";
import { ICON_SOURCES, SOURCE_NAMES, cleanIcon, cleanIconRef, sniffImage, type IconSource } from "../icons.js";
import { KIND_NAMES, applyIcons, listHolders, setIcon, usedFiles, type HolderKind } from "../iconuse.js";

const KINDS = Object.keys(KIND_NAMES) as HolderKind[];
const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/;

export function iconRoutes(app: FastifyInstance, d: Deps): void {
  const { db, access, icons } = d;
  const admin = { preHandler: access.requireAdmin };
  const fail = (reply: FastifyReply, error: unknown, code = 400) => reply.code(code).send({ error: error instanceof Error ? error.message : "That did not work" });
  const send = (reply: FastifyReply, buf: Buffer, mime: string, cache: string) => reply
    .header("Content-Type", mime).header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'").header("Cache-Control", cache).send(buf);

  const updatesList = () => listHolders(db).filter(h => h.iconRef && icons.changed(h.icon, h.iconRef))
    .map(h => ({ key: h.key, kind: h.kind, kindName: KIND_NAMES[h.kind], id: h.id, name: h.name, iconRef: h.iconRef }));

  app.get("/api/icons/status", admin, async () => {
    const counts = icons.counts(), state = icons.state();
    return {
      reviewed: icons.reviewed(), tier: icons.tier(), ready: icons.ready(), sizes: icons.sizes(), updates: updatesList().length,
      sources: ICON_SOURCES.map(id => ({ id, name: SOURCE_NAMES[id], ...state[id], ...counts[id] }))
    };
  });

  app.get("/api/icons/search", admin, async request => icons.search(String((request.query as { q?: string })?.q ?? "")));

  /** A library icon's picture, through this server so the browser never contacts the library sites itself. */
  app.get("/api/icons/preview/:source/:slug", async (request, reply) => {
    const { source, slug } = request.params as { source: string; slug: string };
    if (!(ICON_SOURCES as readonly string[]).includes(source) || !SLUG.test(slug)) return reply.code(404).send({ error: "Not found" });
    const got = await icons.preview(source as IconSource, slug);
    if (!got) return reply.code(404).send({ error: "Not found" });
    return send(reply, got.buf, got.mime, "private, max-age=86400");
  });

  /** Save a library icon ({ref}) or an https image ({url}) as its own copy; the caller then puts the result on something. */
  app.post("/api/icons/pick", admin, async (request, reply) => {
    const b = (request.body ?? {}) as { ref?: string; url?: string };
    try {
      if (b.ref) {
        if (!icons.reviewed()) return fail(reply, new Error("Choose how much of the icon libraries to keep (Settings → Icons) before using them."), 409);
        return await icons.freeze(String(b.ref));
      }
      if (b.url) return await icons.freezeUrl(String(b.url));
      return fail(reply, new Error("Choose an icon"));
    } catch (error) { return fail(reply, error); }
  });

  app.post("/api/icons/upload", admin, async (request, reply) => {
    const file = await request.file({ limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    if (!file) return fail(reply, new Error("No file received"));
    const buf = await file.toBuffer();
    if (file.file.truncated) return fail(reply, new Error("Icons must be 2 MB or smaller"));
    try { return icons.freezeUpload(buf); } catch (error) { return fail(reply, error); }
  });

  /** Put a saved icon on a connection, camera, person or API token (tabs, tiles and Launcher items travel with the dashboard document instead). Empty icon clears it. */
  app.put("/api/icons/assign", admin, async (request, reply) => {
    const b = (request.body ?? {}) as { kind?: string; id?: string; icon?: string; iconRef?: string };
    if (!b.kind || !(KINDS as string[]).includes(b.kind) || typeof b.id !== "string" || !b.id) return fail(reply, new Error("Unknown item"));
    const icon = b.icon ? cleanIcon(b.icon) : "";
    if (b.icon && (!icon || !icons.file(icon))) return fail(reply, new Error("That icon is not saved on this server. Pick it again."));
    if (!setIcon(db, b.kind as HolderKind, b.id, icon, icon ? cleanIconRef(b.iconRef) : "")) return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "settings", `${access.actor(request)} ${icon ? "changed" : "cleared"} the icon of a ${KIND_NAMES[b.kind as HolderKind].toLowerCase()}`, { detail: true });
    return { ok: true };
  });

  app.post("/api/icons/sync/:source", admin, async (request, reply) => {
    const { source } = request.params as { source: string };
    if (!throttleHit(db, "iconsync", 12, 600_000)) return reply.code(429).send({ error: "Refreshed a moment ago. Try again in a few minutes." });
    if (!icons.reviewed()) return fail(reply, new Error("Choose how much of the icon libraries to keep first."), 409);
    if (source === "all") void icons.syncAll();
    else if ((ICON_SOURCES as readonly string[]).includes(source)) void icons.syncSource(source as IconSource);
    else return reply.code(404).send({ error: "Not found" });
    logEvent(db, "info", "system", `${access.actor(request)} started an icon library refresh (${source === "all" ? "all libraries" : SOURCE_NAMES[source as IconSource]})`);
    return { ok: true };
  });

  app.post("/api/icons/clear-cache", admin, async request => {
    rmSync(icons.cacheDir, { recursive: true, force: true });
    logEvent(db, "info", "system", `${access.actor(request)} cleared the saved icon previews`);
    return { ok: true };
  });

  app.get("/api/icons/updates", admin, async () => { const items = updatesList(); return { count: items.length, items }; });

  /** Look up what the library icons in use look like today (one small request each), then say which changed. */
  app.post("/api/icons/check", admin, async (request, reply) => {
    if (!throttleHit(db, "iconcheck", 8, 3600_000)) return reply.code(429).send({ error: "Checked a moment ago. Try again later." });
    const refs = listHolders(db).map(h => h.iconRef).filter(Boolean);
    const checked = await icons.checkUsed(refs);
    logEvent(db, "info", "system", `${access.actor(request)} checked ${refs.length} library icon(s) in use for changes`, { detail: true });
    const items = updatesList();
    return { checked, count: items.length, items };
  });

  /** Replace the saved copy of icons whose library version changed (all of them, or the keys given). Nothing changes unless asked. */
  app.post("/api/icons/refresh", admin, async (request, reply) => {
    const want = (request.body as { keys?: string[] } | undefined)?.keys;
    const todo = listHolders(d.db).filter(h => h.iconRef && icons.changed(h.icon, h.iconRef) && (!want || want.includes(h.key)));
    const changes = new Map<string, { icon: string; iconRef: string }>(); let failed = 0;
    const done = new Map<string, { icon: string; iconRef: string }>();
    for (const h of todo) {
      try { const r = done.get(h.iconRef) ?? await icons.freeze(h.iconRef, { fresh: true }); done.set(h.iconRef, r); changes.set(h.key, r); } catch { failed++; }
    }
    const refreshed = applyIcons(db, changes);
    icons.gc(usedFiles(db));
    logEvent(db, "info", "settings", `${access.actor(request)} refreshed ${refreshed} icon(s) from their libraries${failed ? ` (${failed} could not be downloaded)` : ""}`);
    if (!refreshed && failed) return reply.code(502).send({ error: "The newer icons could not be downloaded right now." });
    return { refreshed, failed };
  });

  // Saved icons are shown to everyone who sees the dashboard. The sandbox policy keeps an SVG from running anything.
  const serve = async (value: string, reply: FastifyReply) => {
    const file = icons.file(value);
    if (!file) return reply.code(404).send({ error: "Not found" });
    const buf = readFileSync(file), kind = sniffImage(buf);
    return send(reply, buf, kind?.mime ?? "application/octet-stream", "public, max-age=31536000, immutable");
  };
  app.get("/icons/used/:file", async (request, reply) => serve(`used/${(request.params as { file: string }).file}`, reply));
  app.get("/icons/:id", async (request, reply) => serve((request.params as { id: string }).id, reply));
}
