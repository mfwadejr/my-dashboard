import { getJson, getBytes, IntegrationError } from "./integrations/http.js";
import type { Store } from "./store.js";

export type Release = "cinema" | "digital" | "physical" | "all";
export interface CalendarEntry {
  key: string; source: "sonarr" | "radarr"; integrationId: string; title: string; subtitle: string; date: string; allDay: boolean;
  state: "downloaded" | "downloading" | "missing" | "upcoming" | "released"; releaseType: string | null; poster: string | null; overview: string | null;
}
export interface CalendarResult { entries: CalendarEntry[]; errors: Array<{ integrationId: string; name: string; error: string }>; sources: Array<{ id: string; name: string; type: string }> }

const cache = new Map<string, { at: number; value: CalendarResult }>();
const TTL_MS = 60_000;
const ep = (e: any) => `S${String(e.seasonNumber ?? 0).padStart(2, "0")}E${String(e.episodeNumber ?? 0).padStart(2, "0")} ${e.title ?? ""}`.trim();
const short = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 280) : null);

/** Posters are served through /api/media-image so the browser never gets the app's address or key. Only the app's own cover folder is allowed. */
const posterOf = (id: string, images: any): string | null => {
  const path = Array.isArray(images) ? images.find((i: any) => i?.coverType === "poster")?.url : null;
  return typeof path === "string" && isCoverPath(path) ? `/api/media-image/${id}?p=${encodeURIComponent(path)}` : null;
};
export const isCoverPath = (p: string) => p.length < 300 && /^\/MediaCover\/[A-Za-z0-9_\-./]+(\?[A-Za-z0-9=&_-]*)?$/.test(p) && !p.includes("..");

export async function buildCalendar(store: Store, ids: string[], start: Date, end: Date, release: Release): Promise<CalendarResult> {
  const key = `${[...ids].sort().join(",")}|${start.toISOString()}|${end.toISOString()}|${release}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const result: CalendarResult = { entries: [], errors: [], sources: [] };
  const now = Date.now();
  await Promise.all(ids.map(async id => {
    const row = store.getIntegration(id);
    if (!row || (row.type !== "sonarr" && row.type !== "radarr")) return;
    result.sources.push({ id, name: row.name, type: row.type });
    const ctx = store.ctxOf(row);
    const headers = { "X-Api-Key": ctx.apiKey };
    const get = (path: string, query: Record<string, string | number | boolean>) => getJson(ctx, path, { headers, query });
    try {
      const range = { start: start.toISOString(), end: end.toISOString(), unmonitored: false };
      if (row.type === "sonarr") {
        const [cal, queue] = await Promise.all([get("/api/v3/calendar", { ...range, includeSeries: true }), get("/api/v3/queue", { page: 1, pageSize: 200 }).catch(() => null)]);
        const downloading = new Set(((queue?.records ?? []) as any[]).map(r => r.episodeId));
        for (const e of (Array.isArray(cal) ? cal : []) as any[]) {
          if (!e.airDateUtc) continue;
          const state = e.hasFile ? "downloaded" : downloading.has(e.id) ? "downloading" : Date.parse(e.airDateUtc) < now ? "missing" : "upcoming";
          result.entries.push({ key: `${id}:e:${e.id}`, source: "sonarr", integrationId: id, title: String(e.series?.title ?? "Unknown"), subtitle: ep(e), date: String(e.airDateUtc), allDay: false, state, releaseType: null, poster: posterOf(id, e.series?.images), overview: short(e.overview) });
        }
      } else {
        const [cal, queue] = await Promise.all([get("/api/v3/calendar", range), get("/api/v3/queue", { page: 1, pageSize: 200 }).catch(() => null)]);
        const downloading = new Set(((queue?.records ?? []) as any[]).map(r => r.movieId));
        const types: Array<[Exclude<Release, "all">, string, string]> = [["cinema", "inCinemas", "Cinema"], ["digital", "digitalRelease", "Digital"], ["physical", "physicalRelease", "Physical"]];
        for (const m of (Array.isArray(cal) ? cal : []) as any[]) {
          for (const [type, field, label] of types) {
            if (release !== "all" && release !== type) continue;
            const date = m[field];
            if (typeof date !== "string") continue;
            const t = Date.parse(date);
            if (!(t >= start.getTime() && t < end.getTime())) continue;
            const state = m.hasFile ? "downloaded" : downloading.has(m.id) ? "downloading" : t >= now ? "upcoming" : type === "cinema" ? "released" : "missing";
            result.entries.push({ key: `${id}:m:${m.id}:${type}`, source: "radarr", integrationId: id, title: String(m.title ?? "Unknown"), subtitle: m.year ? String(m.year) : "", date, allDay: true, state, releaseType: label, poster: posterOf(id, m.images), overview: short(m.overview) });
          }
        }
      }
    } catch (e) {
      result.errors.push({ integrationId: id, name: row.name, error: e instanceof IntegrationError ? e.message : "Could not read the calendar" });
    }
  }));
  result.entries.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.title.localeCompare(b.title));
  result.sources.sort((a, b) => a.name.localeCompare(b.name));
  cache.set(key, { at: Date.now(), value: result });
  if (cache.size > 50) for (const k of cache.keys()) { cache.delete(k); if (cache.size <= 25) break; }
  return result;
}

export async function fetchPoster(store: Store, id: string, path: string): Promise<{ type: string; body: Buffer } | null> {
  const row = store.getIntegration(id);
  if (!row || (row.type !== "sonarr" && row.type !== "radarr") || !isCoverPath(path)) return null;
  const ctx = store.ctxOf(row);
  const r = await getBytes(ctx, path, { "X-Api-Key": ctx.apiKey });
  return r.status === 200 && r.type.startsWith("image/") ? { type: r.type, body: r.body } : null;
}

export const RELEASES = new Set(["cinema", "digital", "physical", "all"]);
