import { getJson, IntegrationError } from "./http.js";
import type { Ctx, IntegrationType, PollResult, TestResult } from "./types.js";

/** SABnzbd takes the key as a query parameter and reports problems as {"status": false, "error": "..."}. */
async function api(ctx: Ctx, mode: string, extra: Record<string, string | number> = {}): Promise<any> {
  const doc = await getJson(ctx, "/api", { query: { mode, output: "json", apikey: ctx.apiKey, ...extra } });
  if (doc && typeof doc === "object" && typeof doc.error === "string") throw new IntegrationError(doc.error);
  return doc;
}

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
  const history = await api(ctx, "history", { limit: 5 }).then(h => h?.history?.slots ?? []).catch(() => []);

  const slots = ((q.slots ?? []) as any[]).map(s => ({
    id: String(s.nzo_id ?? ""), name: String(s.filename ?? "Unknown"), progress: Math.max(0, Math.min(1, num(s.percentage) / 100)),
    sizeMB: num(s.mb), timeleft: s.timeleft ? String(s.timeleft) : null, category: s.cat ? String(s.cat) : null, status: String(s.status ?? "")
  }));
  const speedKBs = num(q.kbpersec);
  const data = {
    version: q.version ?? null,
    status: String(q.status ?? ""),
    paused: Boolean(q.paused),
    speedKBs,
    queue: { count: num(q.noofslots_total ?? q.noofslots), items: slots, sizeLeftMB: num(q.mbleft), totalMB: num(q.mb), timeleft: q.timeleft ? String(q.timeleft) : null },
    diskFreeGB: q.diskspace1 !== undefined ? num(q.diskspace1) : null,
    history: ((history as any[]) ?? []).slice(0, 5).map(h => ({
      name: String(h.name ?? ""), status: String(h.status ?? ""), sizeBytes: num(h.bytes), completed: h.completed ? num(h.completed) : null, category: h.category ?? null
    }))
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
    resume: async ctx => api(ctx, "resume")
  }
};
