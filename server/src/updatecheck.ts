import { getMeta, logEvent, setMeta, type DB } from "./db.js";
import { versionInfo } from "./version.js";

export interface UpdateInfo {
  ts: number; running: string; latest: string; aheadBy: number; upToDate: boolean; error: string | null;
  commits: Array<{ sha: string; message: string; date: string }>; repo: string;
}

const repo = () => process.env.UPDATE_REPO || "mfwadejr/my-dashboard";
const base = () => (process.env.UPDATE_API_BASE || "https://api.github.com").replace(/\/+$/, "");

export const lastUpdateCheck = (db: DB): UpdateInfo | null => { try { return JSON.parse(getMeta(db, "update_check") ?? "null"); } catch { return null; } };

/**
 * Asks GitHub how far the running build is behind the main branch. Only called when the person has switched update checks on;
 * the one request goes to api.github.com and carries nothing about this install except the commit it is running.
 */
export async function checkForUpdate(db: DB, opts: { maxAgeMs?: number } = {}): Promise<UpdateInfo> {
  const prev = lastUpdateCheck(db);
  if (prev && opts.maxAgeMs && Date.now() - prev.ts < opts.maxAgeMs && !prev.error) return prev;
  const running = versionInfo().commit, r = repo();
  const info: UpdateInfo = { ts: Date.now(), running, latest: "", aheadBy: 0, upToDate: false, error: null, commits: [], repo: r };
  try {
    if (!/^[0-9a-f]{7,40}$/i.test(running)) throw new Error("This build does not know which version it is (it was not built by the official image), so it cannot compare itself with GitHub.");
    const res = await fetch(`${base()}/repos/${r}/compare/${running}...main`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Homebase-update-check" }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) throw new Error("GitHub does not know the commit this build came from, so it cannot be compared.");
    if (res.status === 403 || res.status === 429) throw new Error("GitHub is limiting requests right now. Try again later.");
    if (!res.ok) throw new Error(`GitHub answered with an error (${res.status}).`);
    const j = await res.json() as { ahead_by?: number; status?: string; commits?: Array<{ sha: string; commit: { message: string; author?: { date?: string } } }> };
    info.aheadBy = Math.max(0, Number(j.ahead_by) || 0);
    info.upToDate = info.aheadBy === 0;
    const list = j.commits ?? [];
    info.latest = list.length ? list[list.length - 1].sha.slice(0, 7) : running.slice(0, 7);
    info.commits = list.slice(-10).reverse().map(c => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0].slice(0, 140), date: c.commit.author?.date ?? "" }));
  } catch (error) {
    info.error = error instanceof Error ? (error.name === "TimeoutError" ? "GitHub did not answer in time." : /fetch failed/i.test(error.message) ? "GitHub could not be reached from here." : error.message) : "The check failed.";
  }
  setMeta(db, "update_check", JSON.stringify(info));
  if (!info.error && info.aheadBy !== (prev?.aheadBy ?? 0) && info.aheadBy > 0) logEvent(db, "info", "system", `An update is available: ${info.aheadBy} newer change(s) on GitHub, newest "${info.commits[0]?.message ?? ""}"`);
  return info;
}
