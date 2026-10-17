import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";

export interface Mock { server: Server; url: string; hits: string[]; close(): Promise<void> }

export async function start(handler: (req: IncomingMessage, url: URL, hits: string[], body: any) => { status?: number; body?: unknown; text?: string; binary?: Buffer; type?: string; headers?: Record<string, string | string[]> }, tls?: { key: string; cert: string }): Promise<Mock> {
  const hits: string[] = [];
  const listener = (req: IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://mock");
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      let parsed: any = null;
      try { parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; } catch { /* not JSON */ }
      const out = handler(req, url, hits, parsed);
      res.writeHead(out.status ?? 200, { "Content-Type": out.binary ? out.type ?? "application/octet-stream" : out.text !== undefined ? "text/html" : "application/json", ...(out.headers ?? {}) });
      res.end(out.binary ?? (out.text !== undefined ? out.text : JSON.stringify(out.body ?? {})));
    });
  };
  const server = (tls ? createSecureServer(tls, listener) : createServer(listener)) as Server;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `${tls ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, hits, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

export const KEY = "test-key-123";
/** A date relative to now, so tests do not depend on the day they run. */
export const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

export function mockSonarr(): Promise<Mock> {
  return start((req, url) => {
    if (req.headers["x-api-key"] !== KEY) return { status: 401, body: { error: "Unauthorized" } };
    switch (url.pathname) {
      case "/api/v3/system/status": return { body: { appName: "Sonarr", version: "4.0.9.2244" } };
      case "/api/v3/queue": return { body: { totalRecords: 2, records: [
        { id: 1, episodeId: 12, title: "Show.S01E02.1080p", status: "downloading", trackedDownloadState: "downloading", size: 1000, sizeleft: 250, timeleft: "00:10:00", series: { title: "Severance" }, episode: { seasonNumber: 1, episodeNumber: 2, title: "Half Loop" } },
        { id: 2, title: "Other.S02E01", status: "warning", trackedDownloadStatus: "warning", statusMessages: [{ title: "x", messages: ["No files found are eligible for import"] }], quality: { quality: { name: "WEBDL-1080p" } }, downloadClient: "SABnzbd", size: 524288000, sizeleft: 524288000, series: { title: "Andor" }, episode: { seasonNumber: 2, episodeNumber: 1, title: "Pilot" } }
      ] } };
      case "/api/v3/wanted/missing": return { body: { totalRecords: 7, records: [] } };
      case "/api/v3/health": return { body: [{ source: "IndexerStatusCheck", type: "warning", message: "Indexers unavailable due to failures" }, { source: "x", type: "ok", message: "fine" }] };
      case "/api/v3/calendar": return { body: [
        { id: 11, title: "Later", seasonNumber: 1, episodeNumber: 5, airDateUtc: inDays(4), hasFile: false, series: { title: "Andor", images: [{ coverType: "poster", url: "/MediaCover/2/poster.jpg?lastWrite=1" }] } },
        { id: 12, title: "Soon", seasonNumber: 1, episodeNumber: 3, airDateUtc: inDays(1), hasFile: false, overview: "An episode.", series: { title: "Severance", images: [{ coverType: "poster", url: "/MediaCover/1/poster.jpg?lastWrite=1" }, { coverType: "banner", url: "/MediaCover/1/banner.jpg" }] } },
        { id: 13, title: "Got it", seasonNumber: 1, episodeNumber: 2, airDateUtc: inDays(-2), hasFile: true, series: { title: "Severance", images: [{ coverType: "poster", url: "/etc/passwd" }] } }
      ] };
      case "/MediaCover/1/poster.jpg": return { binary: Buffer.from("PNGDATA"), type: "image/png" };
      case "/api/v3/series": return { body: [{ id: 1 }, { id: 2 }, { id: 3, monitored: false }] };
      case "/api/v3/history": return { body: { records: [{ date: "2026-10-14T20:00:00Z", quality: { quality: { name: "HDTV-720p" } }, series: { title: "Severance" }, episode: { seasonNumber: 1, episodeNumber: 1, title: "Good News" } }] } };
      case "/api/v3/diskspace": return { body: [{ path: "/tv", label: "TV", freeSpace: 500e9, totalSpace: 2e12 }, { path: "/tv2", label: "TV copy", freeSpace: 500e9, totalSpace: 2e12 }] };
      case "/api/v3/wanted/cutoff": return { body: { totalRecords: 4, records: [] } };
      default: return { status: 404 };
    }
  });
}

export function mockRadarr(): Promise<Mock> {
  return start((req, url) => {
    if (req.headers["x-api-key"] !== KEY) return { status: 401 };
    switch (url.pathname) {
      case "/api/v3/system/status": return { body: { appName: "Radarr", version: "5.14.0" } };
      case "/api/v3/queue": return { body: { totalRecords: 1, records: [{ id: 9, movieId: 6, title: "Movie.2025.2160p", size: 8000, sizeleft: 2000, timeleft: "00:30:00", trackedDownloadState: "importPending", movie: { title: "Dune", year: 2021 } }] } };
      case "/api/v3/wanted/missing": return { body: { totalRecords: 3, records: [] } };
      case "/api/v3/health": return { body: [] };
      case "/api/v3/calendar": return { body: [{ id: 5, title: "Soon Movie", year: 2026, inCinemas: inDays(-16), digitalRelease: inDays(2), physicalRelease: inDays(40), hasFile: false, images: [{ coverType: "poster", url: "/MediaCover/5/poster.jpg" }] }, { id: 6, title: "Old Movie", year: 2020, digitalRelease: inDays(-6), hasFile: false }] };
      case "/api/v3/movie": return { body: [{ id: 1 }, { id: 2 }] };
      default: return { status: 404 };
    }
  });
}

/** Behaves like SABnzbd: errors come back as JSON with a 200 status. */
export function mockSab(): Promise<Mock & { state: { paused: boolean; calls: string[] } }> {
  const state = { paused: false, calls: [] as string[] };
  return start((_req, url) => {
    if (url.pathname !== "/api") return { status: 404 };
    if (url.searchParams.get("apikey") !== KEY) return { body: { status: false, error: "API Key Incorrect" } };
    const mode = url.searchParams.get("mode");
    if (["retry", "config"].includes(mode ?? "") || url.searchParams.get("name")) state.calls.push(`${mode}:${url.searchParams.get("name") ?? ""}:${url.searchParams.get("value") ?? ""}`);
    if (mode === "queue" && url.searchParams.get("name")) return { body: { status: true } };
    if (mode === "history" && url.searchParams.get("name")) return { body: { status: true } };
    switch (mode) {
      case "retry": return { body: { status: true } };
      case "config": return { body: { status: true } };
      case "queue": return { body: { queue: { version: "4.3.3", status: state.paused ? "Paused" : "Downloading", paused: state.paused, kbpersec: "10240.5", mb: "5000", mbleft: "1250.25", noofslots: 2, noofslots_total: 2, timeleft: "0:02:00", diskspace1: "512.3", diskspacetotal1: "1000.0", speedlimit: "50", have_warnings: "2", slots: [
        { nzo_id: "SABnzbd_nzo_a", filename: "Ubuntu.iso", mb: "4000", percentage: "75", timeleft: "0:01:00", cat: "software", status: "Downloading" },
        { nzo_id: "SABnzbd_nzo_b", filename: "Other.rar", mb: "1000", percentage: "0", timeleft: "0:01:00", cat: "tv", status: "Queued" }
      ] } } };
      case "history": return { body: { history: { day_size: "1.5 G", week_size: "9 G", month_size: "40 G", total_size: "1 T", slots: [{ nzo_id: "SABnzbd_nzo_h1", name: "Done.Item", status: "Completed", bytes: 1048576, completed: 1760000000, category: "tv" }, { nzo_id: "SABnzbd_nzo_h2", name: "Broken.Item", status: "Failed", bytes: 2048, completed: 1760000100, category: "*", fail_message: "Aborted, cannot be completed" }] } } };
      case "version": return { body: { version: "4.3.3" } };
      case "pause": state.paused = true; return { body: { status: true } };
      case "resume": state.paused = false; return { body: { status: true } };
      default: return { body: { status: false, error: "not implemented" } };
    }
  }).then(m => Object.assign(m, { state }));
}

export function mockGo2rtc(): Promise<Mock & { streams: Map<string, string> }> {
  const streams = new Map<string, string>();
  return start((req, url) => {
    if (url.pathname === "/api/streams") {
      if (req.method === "PUT") { streams.set(url.searchParams.get("name")!, url.searchParams.get("src")!); return { body: {} }; }
      if (req.method === "DELETE") { streams.delete(url.searchParams.get("src")!); return { body: {} }; }
      return { body: Object.fromEntries([...streams].map(([k, v]) => [k, { producers: [{ url: v }] }])) };
    }
    if (url.pathname === "/stream.html") return { text: "<html>player</html>" };
    if (url.pathname === "/video-stream.js") return { text: "// player script" };
    if (url.pathname === "/api/config") return { text: "SECRET CONFIG" };
    if (url.pathname === "/api/frame.jpeg") return { text: "jpegbytes" };
    return { status: 404 };
  }).then(m => Object.assign(m, { streams }));
}
