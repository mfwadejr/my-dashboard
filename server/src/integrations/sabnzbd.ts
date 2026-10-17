import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

/** SABnzbd takes the key as a query parameter and reports problems as {"status": false, "error": "..."}. */
async function api(ctx: Ctx, mode: string, extra: Record<string, string | number> = {}): Promise<any> {
  const doc = await getJson(ctx, "/api", { query: { mode, output: "json", apikey: ctx.apiKey, ...extra } });
  if (doc && typeof doc === "object" && typeof doc.error === "string") throw new IntegrationError(doc.error);
  return doc;
}

const jobId = (args: Record<string, unknown>): string => {
  const id = String(args.id ?? "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new IntegrationError("That is not a valid job id");
  return id;
};

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

async function test(ctx: Ctx): Promise<TestResult> {
  const doc = await api(ctx, "queue", { limit: 1 });
  if (!doc?.queue) throw new IntegrationError("That address answered, but it does not look like SABnzbd");
  const version = doc.queue.version ?? (await api(ctx, "version").then(v => v?.version).catch(() => undefined));
  return { ok: true, message: `Connected to SABnzbd${version ? " " + version : ""}`, version };
}

async function poll(ctx: Ctx): Promise<PollResult> {
  const queueDoc = await api(ctx, "queue", { limit: 20 });
  const q = queueDoc?.queue;
  if (!q) throw new IntegrationError("Unexpected answer from SABnzbd");
  const historyDoc = await api(ctx, "history", { limit: 20 }).then(h => h?.history ?? null).catch(() => null);
  const history = historyDoc?.slots ?? [];

  const slots = ((q.slots ?? []) as any[]).map(s => ({
    id: String(s.nzo_id ?? ""), name: String(s.filename ?? "Unknown"), progress: Math.max(0, Math.min(1, num(s.percentage) / 100)),
    sizeMB: num(s.mb), timeleft: s.timeleft ? String(s.timeleft) : null, category: s.cat && s.cat !== "*" ? String(s.cat) : null, status: String(s.status ?? ""),
    priority: s.priority ? String(s.priority) : null
  }));
  const speedKBs = num(q.kbpersec);
  const data = {
    version: q.version ?? null,
    status: String(q.status ?? ""),
    paused: Boolean(q.paused),
    speedKBs,
    queue: { count: num(q.noofslots_total ?? q.noofslots), items: slots, sizeLeftMB: num(q.mbleft), totalMB: num(q.mb), timeleft: q.timeleft ? String(q.timeleft) : null },
    diskFreeGB: q.diskspace1 !== undefined ? num(q.diskspace1) : null,
    diskTotalGB: q.diskspacetotal1 !== undefined ? num(q.diskspacetotal1) : null,
    speedLimitPct: q.speedlimit !== undefined && q.speedlimit !== "" ? num(q.speedlimit) : null,
    warnings: num(q.have_warnings),
    history: ((history as any[]) ?? []).slice(0, 20).map(h => ({
      id: String(h.nzo_id ?? ""), name: String(h.name ?? ""), status: String(h.status ?? ""), sizeBytes: num(h.bytes), completed: h.completed ? num(h.completed) : null,
      category: h.category && h.category !== "*" ? String(h.category) : null, failMessage: h.fail_message ? String(h.fail_message).slice(0, 160) : null
    })),
    totals: historyDoc ? { day: String(historyDoc.day_size ?? ""), week: String(historyDoc.week_size ?? ""), month: String(historyDoc.month_size ?? ""), all: String(historyDoc.total_size ?? "") } : null
  };
  return { data, metrics: { speed_kbs: speedKBs, queue_count: data.queue.count, paused: data.paused ? 1 : 0 } };
}

export const sabnzbd: IntegrationType = {
  id: "sabnzbd",
  name: "SABnzbd",
  description: "Download queue, speed, free disk space, history, pause and resume",
  urlHint: "http://192.168.1.10:8080",
  keyLabel: "SABnzbd API key (Config → General)",
  test, poll,
  actions: {
    pause: async ctx => api(ctx, "pause"),
    resume: async ctx => api(ctx, "resume"),
    // Single jobs. The id comes from the browser, so it is checked before it goes into a request.
    pausejob: async (ctx, args) => api(ctx, "queue", { name: "pause", value: jobId(args) }),
    resumejob: async (ctx, args) => api(ctx, "queue", { name: "resume", value: jobId(args) }),
    deletejob: async (ctx, args) => api(ctx, "queue", { name: "delete", value: jobId(args) }),
    retry: async (ctx, args) => api(ctx, "retry", { value: jobId(args) }),
    removehistory: async (ctx, args) => api(ctx, "history", { name: "delete", value: jobId(args) }),
    /** 0 means no limit; otherwise a percentage of the maximum speed set in SABnzbd. */
    speedlimit: async (ctx, args) => {
      const raw = args.percent;
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new IntegrationError("Choose a limit between 0 and 100 percent");
      return api(ctx, "config", { name: "speedlimit", value: n });
    }
  }
};
