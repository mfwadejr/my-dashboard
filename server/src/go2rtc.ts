import type { Store } from "./store.js";
import type { DB } from "./db.js";
import { logEvent } from "./db.js";

/** Stream names handed to go2rtc. Browsers may only ever ask for these (see the proxy allowlist). */
export const mainName = (cameraId: string) => `cam-${cameraId}`;
export const subName = (cameraId: string) => `cam-${cameraId}-sub`;
export const STREAM_NAME = /^cam-[A-Za-z0-9]+(-sub)?$/;

/** Only these source schemes are accepted. go2rtc also supports exec:/ffmpeg:/echo: sources, which can run commands. */
const SOURCE = /^(rtsp|rtsps|rtmp|http|https):\/\/[^\s]+$/i;
/**
 * UniFi Protect shows a secure link (rtsps://host:7441/<token>?enableSrtp) that go2rtc usually cannot play. The same stream is served as
 * plain RTSP on port 7447 with the same token. Only that exact shape is rewritten; any other address is left as it is.
 */
const UNIFI_SECURE = /^rtsps:\/\/((?:[^\/\s@]+@)?[^\/\s:@]+):7441(\/[^\s?#]+)(?:\?enableSrtp(?:=[^\s&]*)?)?$/i;
export function convertUnifiSource(url: string): { url: string; converted: boolean } {
  const m = UNIFI_SECURE.exec(url);
  return m ? { url: `rtsp://${m[1]}:7447${m[2]}`, converted: true } : { url, converted: false };
}

export function validCameraSource(url: string): boolean { return url.length <= 600 && SOURCE.test(url); }

export class Go2rtc {
  private timer?: NodeJS.Timeout;
  private lastReachable: boolean | null = null;

  constructor(private base: string | null, private store: Store, private db: DB) {}

  get enabled(): boolean { return this.base !== null; }

  private async call(method: string, path: string, params: Record<string, string>): Promise<Response> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return fetch(url, { method, signal: AbortSignal.timeout(5000) });
  }

  async upsert(cameraId: string): Promise<void> {
    if (!this.base) return;
    const cam = this.store.getCamera(cameraId);
    if (!cam) return;
    const put = async (name: string, src: string) => {
      const res = await this.call("PUT", "/api/streams", { name, src });
      if (!res.ok) throw new Error(`go2rtc answered ${res.status}`);
    };
    await put(mainName(cameraId), cam.main);
    // Without a separate sub-stream the grid just uses the main stream under a second name.
    await put(subName(cameraId), cam.sub || cam.main);
  }

  async remove(cameraId: string): Promise<void> {
    if (!this.base) return;
    await this.call("DELETE", "/api/streams", { src: mainName(cameraId) }).catch(() => {});
    await this.call("DELETE", "/api/streams", { src: subName(cameraId) }).catch(() => {});
  }

  async status(): Promise<{ enabled: boolean; reachable: boolean }> {
    if (!this.base) return { enabled: false, reachable: false };
    try { const res = await this.call("GET", "/api/streams", {}); return { enabled: true, reachable: res.ok }; }
    catch { return { enabled: true, reachable: false }; }
  }

  /** Make go2rtc match our camera list (it can lose streams on restart if its config isn't writable). */
  async reconcile(): Promise<void> {
    if (!this.base) return;
    try {
      const res = await this.call("GET", "/api/streams", {});
      if (!res.ok) throw new Error(`go2rtc answered ${res.status}`);
      const have = new Set(Object.keys((await res.json()) as Record<string, unknown>));
      for (const { id } of this.store.listCameras()) {
        if (!have.has(mainName(id)) || !have.has(subName(id))) await this.upsert(id);
      }
      for (const name of have) {
        if (!STREAM_NAME.test(name)) continue; // never touch streams someone configured by hand
        const id = name.replace(/^cam-/, "").replace(/-sub$/, "");
        if (!this.store.getCamera(id)) await this.call("DELETE", "/api/streams", { src: name }).catch(() => {});
      }
      if (this.lastReachable === false) logEvent(this.db, "info", "go2rtc", "Camera relay is reachable again");
      this.lastReachable = true;
    } catch (error) {
      if (this.lastReachable !== false) logEvent(this.db, "warn", "go2rtc", `Camera relay unreachable: ${error instanceof Error ? error.message : error}`);
      this.lastReachable = false;
    }
  }

  start(): void {
    if (!this.base) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 60_000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}
