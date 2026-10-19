import type { DayBar, MonitorState } from "../types";

export const STATE_LABEL: Record<MonitorState, string> = { up: "Up", down: "Down", pending: "Retrying", paused: "Paused", unknown: "Waiting" };

export function StateDot({ state }: { state: MonitorState }) {
  return <span className={`mdot ${state}`} role="img" aria-label={STATE_LABEL[state]} title={STATE_LABEL[state]} />;
}

/** The last few checks as small bars: green up, red down, amber retrying. */
export function Strip({ checks, count = 24 }: { checks: Array<0 | 1 | 2>; count?: number }) {
  const shown = checks.slice(-count), pad = count - shown.length;
  return (
    <span className="mstrip" aria-hidden="true">
      {Array.from({ length: pad }, (_, i) => <i key={`p${i}`} className="s-" />)}
      {shown.map((s, i) => <i key={i} className={`s${s}`} />)}
    </span>
  );
}

/** One bar per day: green when every check passed, amber when some failed, red when most did, grey with no data. */
export function DayBars({ days }: { days: DayBar[] }) {
  return (
    <span className="mdays" aria-hidden="true">
      {days.map(d => {
        const total = d.up + d.down, tone = total === 0 ? "none" : d.down === 0 ? "ok" : d.down / total > 0.5 ? "bad" : "warn";
        return <i key={d.day} className={tone} title={`${new Date(d.day * 86400000).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })}: ${total ? `${Math.round((d.up / total) * 1000) / 10}% up` : "no data"}`} />;
      })}
    </span>
  );
}

export const fmtPct = (n: number | null | undefined) => n === null || n === undefined ? "–" : `${n >= 99.995 || n === 0 ? Math.round(n) : n.toFixed(n >= 99 ? 2 : 1).replace(/\.?0+$/, "")}%`;
export const fmtMs = (n: number | null | undefined) => n === null || n === undefined ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`;
