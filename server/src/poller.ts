import { logEvent, type DB } from "./db.js";
import type { Hub } from "./hub.js";
import type { Store, IntegrationRow } from "./store.js";
import { INTEGRATION_TYPES } from "./integrations/registry.js";

export interface Snapshot {
  id: string;
  ok: boolean;
  /** When the data was last fetched successfully (ms). */
  ts: number | null;
  /** When we last tried (ms). */
  checkedAt: number;
  error: string | null;
  data: unknown;
}

const METRIC_EVERY_MS = 30_000;
const RETENTION_MS = 14 * 86400_000;

/** Polls each enabled integration on its own timer, caches the latest result, stores history, and pushes live updates. */
export class Poller {
  private snapshots = new Map<string, Snapshot>();
  private timers = new Map<string, NodeJS.Timeout>();
  private failures = new Map<string, number>();
  private lastMetricAt = new Map<string, number>();
  private pruneTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private db: DB, private store: Store, private hub: Hub) {}

  start(): void {
    for (const row of this.store.listIntegrations()) if (row.enabled) this.schedule(row.id, 0);
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), 3600_000);
    this.pruneTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  all(): Snapshot[] { return [...this.snapshots.values()]; }
  get(id: string): Snapshot | undefined { return this.snapshots.get(id); }

  /** Called after an integration is created, edited or removed. */
  reload(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.failures.delete(id);
    const row = this.store.getIntegration(id);
    if (!row) {
      this.snapshots.delete(id);
      this.hub.broadcast("removed", { id });
      return;
    }
    if (row.enabled) this.schedule(id, 0);
    else { this.snapshots.delete(id); this.hub.broadcast("removed", { id }); }
  }

  private schedule(id: string, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => void this.run(id), delayMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  async run(id: string): Promise<Snapshot | undefined> {
    const row = this.store.getIntegration(id);
    if (!row || !row.enabled) return undefined;
    const previous = this.snapshots.get(id);
    const snapshot = await this.fetchOnce(row, previous);
    this.snapshots.set(id, snapshot);
    this.hub.broadcast("snapshot", snapshot);

    if (previous && previous.ok !== snapshot.ok) {
      logEvent(this.db, snapshot.ok ? "info" : "warn", row.name, snapshot.ok ? "Back online" : `Unreachable: ${snapshot.error}`);
    }
    const fails = snapshot.ok ? 0 : (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, fails);
    // Back off up to 5 minutes while an app is down so a dead server isn't hammered.
    const base = Math.max(5, row.interval_s) * 1000;
    this.schedule(id, fails ? Math.min(base * 2 ** Math.min(fails, 5), 300_000) : base);
    return snapshot;
  }

  private async fetchOnce(row: IntegrationRow, previous?: Snapshot): Promise<Snapshot> {
    const type = INTEGRATION_TYPES[row.type];
    const checkedAt = Date.now();
    if (!type) return { id: row.id, ok: false, ts: previous?.ts ?? null, checkedAt, error: `Unknown integration type "${row.type}"`, data: previous?.data ?? null };
    try {
      const result = await type.poll(this.store.ctxOf(row));
      this.recordMetrics(row.id, result.metrics, checkedAt);
      return { id: row.id, ok: true, ts: checkedAt, checkedAt, error: null, data: result.data };
    } catch (error) {
      // Keep showing the last good data (marked stale) rather than blanking the tile.
      return { id: row.id, ok: false, ts: previous?.ts ?? null, checkedAt, error: error instanceof Error ? error.message : "Unknown error", data: previous?.data ?? null };
    }
  }

  private recordMetrics(id: string, metrics: Record<string, number>, now: number): void {
    if (now - (this.lastMetricAt.get(id) ?? 0) < METRIC_EVERY_MS) return;
    this.lastMetricAt.set(id, now);
    const insert = this.db.prepare("INSERT INTO metrics (instance_id, key, ts, value) VALUES (?, ?, ?, ?)");
    for (const [key, value] of Object.entries(metrics)) if (Number.isFinite(value)) insert.run(id, key, now, value);
  }

  private prune(): void {
    this.db.prepare("DELETE FROM metrics WHERE ts < ?").run(Date.now() - RETENTION_MS);
    this.db.prepare("DELETE FROM events WHERE ts < ?").run(Date.now() - 30 * 86400_000);
  }
}

/** History for sparklines: averages the stored points into at most `points` buckets. */
export function readSeries(db: DB, id: string, key: string, minutes: number, points = 120): Array<[number, number]> {
  const since = Date.now() - minutes * 60_000;
  const rows = db.prepare("SELECT ts, value FROM metrics WHERE instance_id = ? AND key = ? AND ts >= ? ORDER BY ts").all(id, key, since) as unknown as Array<{ ts: number; value: number }>;
  if (rows.length <= points) return rows.map(r => [r.ts, r.value]);
  const bucket = (Date.now() - since) / points;
  const out: Array<[number, number]> = [];
  let index = -1, sum = 0, count = 0, first = 0;
  for (const row of rows) {
    const i = Math.floor((row.ts - since) / bucket);
    if (i !== index) { if (count) out.push([first, sum / count]); index = i; sum = 0; count = 0; first = row.ts; }
    sum += row.value; count++;
  }
  if (count) out.push([first, sum / count]);
  return out;
}
