import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";

export interface Mock { server: Server; url: string; hits: string[]; close(): Promise<void> }

export async function start(handler: (req: IncomingMessage, url: URL, hits: string[], body: any) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string | string[]> }, tls?: { key: string; cert: string }): Promise<Mock> {
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
      res.writeHead(out.status ?? 200, { "Content-Type": out.text !== undefined ? "text/html" : "application/json", ...(out.headers ?? {}) });
      res.end(out.text !== undefined ? out.text : JSON.stringify(out.body ?? {}));
    });
  };
  const server = (tls ? createSecureServer(tls, listener) : createServer(listener)) as Server;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `${tls ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, hits, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

export const KEY = "test-key-123";

export function mockSonarr(): Promise<Mock> {
  return start((req, url) => {
    if (req.headers["x-api-key"] !== KEY) return { status: 401, body: { error: "Unauthorized" } };
    switch (url.pathname) {
      case "/api/v3/system/status": return { body: { appName: "Sonarr", version: "4.0.9.2244" } };
      case "/api/v3/queue": return { body: { totalRecords: 2, records: [
        { id: 1, title: "Show.S01E02.1080p", status: "downloading", trackedDownloadState: "downloading", size: 1000, sizeleft: 250, timeleft: "00:10:00", series: { title: "Severance" }, episode: { seasonNumber: 1, episodeNumber: 2, title: "Half Loop" } },
        { id: 2, title: "Other.S02E01", status: "queued", size: 500, sizeleft: 500, series: { title: "Andor" }, episode: { seasonNumber: 2, episodeNumber: 1, title: "Pilot" } }
      ] } };
      case "/api/v3/wanted/missing": return { body: { totalRecords: 7, records: [] } };
      case "/api/v3/health": return { body: [{ source: "IndexerStatusCheck", type: "warning", message: "Indexers unavailable due to failures" }, { source: "x", type: "ok", message: "fine" }] };
      case "/api/v3/calendar": return { body: [
        { title: "Later", seasonNumber: 1, episodeNumber: 5, airDateUtc: "2026-10-20T01:00:00Z", hasFile: false, series: { title: "Andor" } },
        { title: "Soon", seasonNumber: 1, episodeNumber: 3, airDateUtc: "2026-10-16T01:00:00Z", hasFile: false, series: { title: "Severance" } }
      ] };
      case "/api/v3/series": return { body: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      default: return { status: 404 };
    }
  });
}

export function mockRadarr(): Promise<Mock> {
  return start((req, url) => {
    if (req.headers["x-api-key"] !== KEY) return { status: 401 };
    switch (url.pathname) {
      case "/api/v3/system/status": return { body: { appName: "Radarr", version: "5.14.0" } };
      case "/api/v3/queue": return { body: { totalRecords: 1, records: [{ id: 9, title: "Movie.2025.2160p", size: 8000, sizeleft: 2000, timeleft: "00:30:00", trackedDownloadState: "importPending", movie: { title: "Dune", year: 2021 } }] } };
      case "/api/v3/wanted/missing": return { body: { totalRecords: 3, records: [] } };
      case "/api/v3/health": return { body: [] };
      case "/api/v3/calendar": return { body: [{ title: "Soon Movie", year: 2026, digitalRelease: "2026-10-18T00:00:00Z", hasFile: false }] };
      case "/api/v3/movie": return { body: [{ id: 1 }, { id: 2 }] };
      default: return { status: 404 };
    }
  });
}

/** Behaves like SABnzbd: errors come back as JSON with a 200 status. */
export function mockSab(): Promise<Mock & { state: { paused: boolean } }> {
  const state = { paused: false };
  return start((_req, url) => {
    if (url.pathname !== "/api") return { status: 404 };
    if (url.searchParams.get("apikey") !== KEY) return { body: { status: false, error: "API Key Incorrect" } };
    switch (url.searchParams.get("mode")) {
      case "queue": return { body: { queue: { version: "4.3.3", status: state.paused ? "Paused" : "Downloading", paused: state.paused, kbpersec: "10240.5", mb: "5000", mbleft: "1250.25", noofslots: 2, noofslots_total: 2, timeleft: "0:02:00", diskspace1: "512.3", slots: [
        { nzo_id: "SABnzbd_nzo_a", filename: "Ubuntu.iso", mb: "4000", percentage: "75", timeleft: "0:01:00", cat: "software", status: "Downloading" },
        { nzo_id: "SABnzbd_nzo_b", filename: "Other.rar", mb: "1000", percentage: "0", timeleft: "0:01:00", cat: "tv", status: "Queued" }
      ] } } };
      case "history": return { body: { history: { slots: [{ name: "Done.Item", status: "Completed", bytes: 1048576, completed: 1760000000, category: "tv" }] } } };
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
