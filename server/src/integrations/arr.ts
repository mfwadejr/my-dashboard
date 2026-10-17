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
    const start = new Date(), end = new Date(Date.now() + 14 * 86400_000);
    const queueQuery = { page: 1, pageSize: 30, ...(kind === "sonarr" ? { includeSeries: true, includeEpisode: true } : { includeMovie: true }) };
    const historyQuery = { page: 1, pageSize: 10, sortKey: "date", sortDirection: "descending", eventType: 3, ...(kind === "sonarr" ? { includeSeries: true, includeEpisode: true } : { includeMovie: true }) };
    const calendarQuery = { start: iso(start), end: iso(end), unmonitored: false, ...(kind === "sonarr" ? { includeSeries: true } : {}) };

    // The status call must work. Every other call is optional so one slow endpoint doesn't blank the tile.
    const status = await get(ctx, "/api/v3/system/status");
    const [queue, missing, health, calendar, library, history, disks, cutoff] = await Promise.allSettled([
      get(ctx, "/api/v3/queue", queueQuery),
      get(ctx, "/api/v3/wanted/missing", { page: 1, pageSize: 1, monitored: true }),
      get(ctx, "/api/v3/health"),
      get(ctx, "/api/v3/calendar", calendarQuery),
      get(ctx, kind === "sonarr" ? "/api/v3/series" : "/api/v3/movie"),
      get(ctx, "/api/v3/history", historyQuery),
      get(ctx, "/api/v3/diskspace"),
      get(ctx, "/api/v3/wanted/cutoff", { page: 1, pageSize: 1, monitored: true })
    ]);
    const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

    const queueDoc = ok(queue);
    const queueItems = ((queueDoc?.records ?? []) as any[]).map(r => {
      const title = kind === "sonarr" ? (r.series?.title ?? r.title) : (r.movie?.title ?? r.title);
      const subtitle = kind === "sonarr" && r.episode
        ? `S${String(r.episode.seasonNumber).padStart(2, "0")}E${String(r.episode.episodeNumber).padStart(2, "0")} ${r.episode.title ?? ""}`.trim()
        : kind === "radarr" && r.movie?.year ? String(r.movie.year) : "";
      const trouble = ["warning", "error"].includes(String(r.trackedDownloadStatus ?? "").toLowerCase()) || /fail/i.test(String(r.status ?? ""));
      const messages = ((r.statusMessages ?? []) as any[]).flatMap(m => (m?.messages ?? []) as string[]).concat(r.errorMessage ? [String(r.errorMessage)] : []).slice(0, 3);
      return {
        id: r.id, title: String(title ?? "Unknown"), subtitle, progress: progress(r.size, r.sizeleft), timeleft: r.timeleft ?? null, status: String(r.trackedDownloadState ?? r.status ?? ""),
        quality: r.quality?.quality?.name ? String(r.quality.quality.name) : null, client: r.downloadClient ? String(r.downloadClient) : null, sizeMB: Number(r.size) > 0 ? Number(r.size) / 1048576 : null,
        trouble, messages: messages.map(m => String(m).slice(0, 200))
      };
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
    }).filter(e => e.date).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 25);

    const recent = ((ok(history)?.records ?? []) as any[]).map(r => ({
      title: String((kind === "sonarr" ? r.series?.title : r.movie?.title) ?? r.sourceTitle ?? "Unknown"),
      subtitle: kind === "sonarr" && r.episode ? `S${String(r.episode.seasonNumber).padStart(2, "0")}E${String(r.episode.episodeNumber).padStart(2, "0")} ${r.episode.title ?? ""}`.trim() : kind === "radarr" && r.movie?.year ? String(r.movie.year) : "",
      date: r.date ?? null, quality: r.quality?.quality?.name ? String(r.quality.quality.name) : null
    })).slice(0, 10);
    const seen = new Set<string>();
    const diskList = ((ok(disks) ?? []) as any[]).filter(d => Number(d?.totalSpace) > 0).filter(d => { const k = `${d.totalSpace}:${d.freeSpace}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(d => ({ label: String(d.label || d.path || "Disk"), freeB: Number(d.freeSpace), totalB: Number(d.totalSpace) })).slice(0, 4);

    const libraryDoc = ok(library);
    const data = {
      version: status.version ?? null,
      appName: status.appName ?? label,
      queue: { count: Number(queueDoc?.totalRecords ?? queueItems.length), items: queueItems },
      missing: missing.status === "fulfilled" ? Number(missing.value?.totalRecords ?? 0) : null,
      health: { issues: issues.length, messages: issues.slice(0, 5).map(h => String(h.message ?? h.source ?? "")) },
      upcoming,
      libraryCount: Array.isArray(libraryDoc) ? libraryDoc.length : null,
      monitoredCount: Array.isArray(libraryDoc) ? libraryDoc.filter((x: any) => x?.monitored !== false).length : null,
      cutoffUnmet: cutoff.status === "fulfilled" ? Number(cutoff.value?.totalRecords ?? 0) : null,
      troubleCount: queueItems.filter(i => i.trouble).length,
      recent, disks: diskList
    };
    const metrics: Record<string, number> = { queue_count: data.queue.count, health_issues: data.health.issues };
    if (data.missing !== null) metrics.missing = data.missing;
    metrics.queue_trouble = data.troubleCount;
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
