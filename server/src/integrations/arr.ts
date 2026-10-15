import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

type Kind = "sonarr" | "radarr";

const iso = (date: Date) => date.toISOString();

function progress(size: unknown, left: unknown): number {
  const total = Number(size), remaining = Number(left);
  return total > 0 ? Math.max(0, Math.min(1, 1 - remaining / total)) : 0;
}

/** Sonarr and Radarr share the same v3 API shape, so one factory builds both. */
function makeArr(kind: Kind): IntegrationType {
  const label = kind === "sonarr" ? "Sonarr" : "Radarr";
  const headers = (ctx: Ctx) => ({ "X-Api-Key": ctx.apiKey });
  const get = (ctx: Ctx, path: string, query?: Record<string, string | number | boolean>) => getJson(ctx, path, { headers: headers(ctx), query });

  async function test(ctx: Ctx): Promise<TestResult> {
    const status = await get(ctx, "/api/v3/system/status");
    const appName = String(status.appName ?? status.instanceName ?? "");
    if (appName && !appName.toLowerCase().includes(kind) && !String(status.instanceName ?? "").toLowerCase().includes(kind)) {
      // A renamed instance can still be fine, so only warn when the app clearly is the other one.
      const other = kind === "sonarr" ? "radarr" : "sonarr";
      if (appName.toLowerCase().includes(other)) return { ok: false, message: `This address is ${appName}, not ${label}` };
    }
    return { ok: true, message: `Connected to ${appName || label}${status.version ? " " + status.version : ""}`, version: status.version };
  }

  async function poll(ctx: Ctx): Promise<PollResult> {
    const start = new Date(), end = new Date(Date.now() + 7 * 86400_000);
    const queueQuery = { page: 1, pageSize: 20, ...(kind === "sonarr" ? { includeSeries: true, includeEpisode: true } : { includeMovie: true }) };
    const calendarQuery = { start: iso(start), end: iso(end), unmonitored: false, ...(kind === "sonarr" ? { includeSeries: true } : {}) };

    // The status call must work. Every other call is optional so one slow endpoint doesn't blank the tile.
    const status = await get(ctx, "/api/v3/system/status");
    const [queue, missing, health, calendar, library] = await Promise.allSettled([
      get(ctx, "/api/v3/queue", queueQuery),
      get(ctx, "/api/v3/wanted/missing", { page: 1, pageSize: 1, monitored: true }),
      get(ctx, "/api/v3/health"),
      get(ctx, "/api/v3/calendar", calendarQuery),
      get(ctx, kind === "sonarr" ? "/api/v3/series" : "/api/v3/movie")
    ]);
    const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

    const queueDoc = ok(queue);
    const queueItems = ((queueDoc?.records ?? []) as any[]).map(r => {
      const title = kind === "sonarr" ? (r.series?.title ?? r.title) : (r.movie?.title ?? r.title);
      const subtitle = kind === "sonarr" && r.episode
        ? `S${String(r.episode.seasonNumber).padStart(2, "0")}E${String(r.episode.episodeNumber).padStart(2, "0")} ${r.episode.title ?? ""}`.trim()
        : kind === "radarr" && r.movie?.year ? String(r.movie.year) : "";
      return { id: r.id, title: String(title ?? "Unknown"), subtitle, progress: progress(r.size, r.sizeleft), timeleft: r.timeleft ?? null, status: String(r.trackedDownloadState ?? r.status ?? "") };
    });

    const healthList = (ok(health) ?? []) as any[];
    const issues = healthList.filter(h => h.type === "warning" || h.type === "error");

    const upcoming = ((ok(calendar) ?? []) as any[]).map(e => {
      if (kind === "sonarr") {
        return {
          title: String(e.series?.title ?? "Unknown"),
          subtitle: `S${String(e.seasonNumber ?? 0).padStart(2, "0")}E${String(e.episodeNumber ?? 0).padStart(2, "0")} ${e.title ?? ""}`.trim(),
          date: e.airDateUtc ?? null, hasFile: Boolean(e.hasFile)
        };
      }
      const date = e.digitalRelease ?? e.physicalRelease ?? e.inCinemas ?? null;
      return { title: String(e.title ?? "Unknown"), subtitle: e.year ? String(e.year) : "", date, hasFile: Boolean(e.hasFile) };
    }).filter(e => e.date).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 10);

    const libraryDoc = ok(library);
    const data = {
      version: status.version ?? null,
      appName: status.appName ?? label,
      queue: { count: Number(queueDoc?.totalRecords ?? queueItems.length), items: queueItems },
      missing: missing.status === "fulfilled" ? Number(missing.value?.totalRecords ?? 0) : null,
      health: { issues: issues.length, messages: issues.slice(0, 5).map(h => String(h.message ?? h.source ?? "")) },
      upcoming,
      libraryCount: Array.isArray(libraryDoc) ? libraryDoc.length : null
    };
    const metrics: Record<string, number> = { queue_count: data.queue.count, health_issues: data.health.issues };
    if (data.missing !== null) metrics.missing = data.missing;
    return { data, metrics };
  }

  return {
    id: kind,
    name: label,
    description: kind === "sonarr" ? "TV queue, missing episodes, upcoming episodes and health" : "Movie queue, missing movies, upcoming releases and health",
    urlHint: kind === "sonarr" ? "http://192.168.1.10:8989" : "http://192.168.1.10:7878",
    keyLabel: `${label} API key (Settings → General)`,
    test, poll
  };
}

export const sonarr = makeArr("sonarr");
export const radarr = makeArr("radarr");
export { IntegrationError };
