import { KEY, start, type Mock } from "./mocks.js";

const BOOT = new Date(Date.now() - 3 * 86400_000).toISOString();

/** Unraid GraphQL. `legacy` mimics an older release that lacks several fields, to prove the fallbacks work. */
export function mockUnraid(opts: { legacy?: boolean } = {}): Promise<Mock & { queries: string[] }> {
  const queries: string[] = [];
  return start((req, url, _hits, body) => {
    if (url.pathname !== "/graphql" || req.method !== "POST") return { status: 404 };
    if (req.headers["x-api-key"] !== KEY) return { status: 401, body: { errors: [{ message: "Unauthorized" }] } };
    const q: string = String(body?.query ?? "");
    queries.push(q);
    if (q.includes("metrics")) return { body: { data: { metrics: { cpu: { percentTotal: 23.5 }, memory: { total: 34359738368, used: 12884901888, percentTotal: 37.5 } } } } };
    if (q.includes("array")) {
      if (opts.legacy && (q.includes("parityCheckStatus") || q.includes("kilobytes"))) return { body: { errors: [{ message: 'Cannot query field "parityCheckStatus" on type "UnraidArray".' }] } };
      if (opts.legacy) return { body: { data: { array: { state: "STARTED", capacity: { disks: { free: "1000", used: "3000", total: "4000" } }, disks: [{ name: "disk1", status: "DISK_OK", temp: 31, size: 4000 }] } } } };
      return { body: { data: { array: {
        state: "STARTED", capacity: { kilobytes: { free: "2000000", used: "6000000", total: "8000000" } },
        parities: [{ name: "parity", status: "DISK_OK", temp: 33 }],
        disks: [{ name: "disk1", status: "DISK_OK", temp: 36, fsSize: 4000, fsUsed: 3000, fsFree: 1000, isSpinning: true, numErrors: 0 }, { name: "disk2", status: "DISK_DSBL", temp: 52, fsSize: 4000, fsUsed: 1000, fsFree: 3000, isSpinning: false, numErrors: 3 }],
        caches: [{ name: "cache", status: "DISK_OK", temp: 40, fsSize: 1000, fsUsed: 500, fsFree: 500 }],
        parityCheckStatus: { status: "RUNNING", progress: 42, running: true, paused: false, errors: 0 } } } } };
    }
    if (q.includes("docker")) return { body: { data: { docker: { containers: [
      { id: "a", names: ["/plex"], state: "RUNNING", status: "Up 2 days", autoStart: true, isUpdateAvailable: true },
      { id: "b", names: ["/sonarr"], state: "RUNNING", status: "Up", autoStart: true, isUpdateAvailable: false },
      { id: "c", names: ["/old-thing"], state: "EXITED", status: "Exited", autoStart: false, isUpdateAvailable: false }] } } } };
    if (q.includes("vms")) return { body: { errors: [{ message: "Forbidden resource" }] } };
    if (q.includes("notifications")) return { body: { data: { notifications: { overview: { unread: { info: 2, warning: 1, alert: 0, total: 3 } } } } } };
    if (q.includes("info")) return { body: { data: { info: { os: { hostname: "tower", uptime: BOOT }, cpu: { brand: "Ryzen 5", cores: 6, threads: 12 } } } } };
    return { body: { errors: [{ message: "unknown" }] } };
  }).then(m => Object.assign(m, { queries }));
}

export const ZIMA_USER = "admin", ZIMA_PASS = "hunter2-pass";
export function mockZima(): Promise<Mock & { logins: () => number }> {
  let logins = 0;
  const TOKEN = "jwt.token.value";
  return start((req, url, _h, body) => {
    if (url.pathname === "/v1/users/login") {
      logins++;
      if (body?.username !== ZIMA_USER || body?.password !== ZIMA_PASS) return { status: 401, body: { success: 401, message: "invalid" } };
      return { body: { success: 200, message: "ok", data: { token: { access_token: TOKEN, refresh_token: "r", expires_at: 1 }, user: { username: ZIMA_USER } } } };
    }
    if (req.headers.authorization !== TOKEN) return { status: 401, body: { success: 401 } };
    switch (url.pathname) {
      case "/v1/sys/utilization": return { body: { success: 200, data: { cpu: { percent: 18.2, num: 4, temperature: 51, power: 9.5, model: "intel" }, mem: { total: 8589934592, used: 4294967296, usedPercent: 50 }, net: [] } } };
      case "/v1/sys/version/check": return { body: { success: 200, data: { need_update: true, version: "1.5.4", current_version: "1.5.3" } } };
      case "/v1/sys/hardware/info": return { body: { success: 200, data: { drive_model: "ZimaCube", arch: "amd64" } } };
      case "/v1/sys/disk": return { body: { success: 200, data: { size: 100000000000, used: 25000000000, avail: 75000000000 } } };
      case "/v2/local_storage/disk": return { body: { data: [{ name: "sda", model: "WD Red", size: 4000000000000, temperature: 38, health: "true" }, { name: "nvme0", model: "Samsung", size: 1000000000000, temperature: 44 }] } };
      default: return { status: 404 };
    }
  }).then(m => Object.assign(m, { logins: () => logins }));
}
