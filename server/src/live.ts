import type { Store } from "./store.js";
import { INTEGRATION_TYPES } from "./integrations/registry.js";

export interface LiveSample { t: number; v: Record<string, number | null> }
interface State { timer: NodeJS.Timeout | null; lastAsk: number; buffer: LiveSample[]; busy: boolean; error: string | null }

const IDLE_MS = 30_000, KEEP = 300;

/**
 * Fast samples for live graphs (a few seconds apart). Sampling starts when a browser asks for an app's live data and stops about
 * 30 seconds after the last ask, so nothing polls fast while nobody is looking.
 */
export class LiveSampler {
  private states = new Map<string, State>();
  constructor(private store: Store) {}

  supports(id: string): boolean {
    const row = this.store.getIntegration(id);
    return Boolean(row && INTEGRATION_TYPES[row.type]?.live);
  }

  read(id: string, since: number): { intervalMs: number; samples: LiveSample[]; error: string | null } | null {
    const row = this.store.getIntegration(id);
    const live = row ? INTEGRATION_TYPES[row.type]?.live : undefined;
    if (!row || !live) return null;
    let st = this.states.get(id);
    if (!st) { st = { timer: null, lastAsk: 0, buffer: [], busy: false, error: null }; this.states.set(id, st); }
    st.lastAsk = Date.now();
    if (!st.timer) {
      void this.tick(id);
      st.timer = setInterval(() => void this.tick(id), live.intervalMs);
      st.timer.unref?.();
    }
    return { intervalMs: live.intervalMs, samples: st.buffer.filter(s => s.t > since), error: st.error };
  }

  private async tick(id: string): Promise<void> {
    const st = this.states.get(id);
    if (!st) return;
    if (Date.now() - st.lastAsk > IDLE_MS) { if (st.timer) clearInterval(st.timer); this.states.delete(id); return; }
    if (st.busy) return;
    const row = this.store.getIntegration(id);
    const live = row ? INTEGRATION_TYPES[row.type]?.live : undefined;
    if (!row || !live) { if (st.timer) clearInterval(st.timer); this.states.delete(id); return; }
    st.busy = true;
    try {
      const v = await live.sample(this.store.ctxOf(row));
      st.buffer.push({ t: Date.now(), v });
      if (st.buffer.length > KEEP) st.buffer.splice(0, st.buffer.length - KEEP);
      st.error = null;
    } catch (e) { st.error = e instanceof Error ? e.message : "Sampling failed"; }
    finally { st.busy = false; }
  }

  stop(): void { for (const st of this.states.values()) if (st.timer) clearInterval(st.timer); this.states.clear(); }
}
