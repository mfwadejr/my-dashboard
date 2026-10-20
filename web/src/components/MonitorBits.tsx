import type { DayBar, MonitorState } from "../types";

export const STATE_LABEL: Record<MonitorState, string> = { up: "Up", down: "Down", pending: "Retrying", paused: "Paused", maintenance: "Maintenance", unknown: "Waiting" };

export function StateDot({ state }: { state: MonitorState }) {
  return <span className={`mdot ${state}`} role="img" aria-label={STATE_LABEL[state]} title={STATE_LABEL[state]} />;
}

/** The last few checks as small bars: green up, red down, amber retrying, accent for maintenance. */
export function Strip({ checks, count = 24 }: { checks: Array<0 | 1 | 2 | 3>; count?: number }) {
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
    <span className="mdays" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${Math.max(1, days.length)},minmax(0,1fr))` }}>
      {days.map(d => {
        const total = d.up + d.down, tone = total === 0 ? "none" : d.down === 0 ? "ok" : d.down / total > 0.5 ? "bad" : "warn";
        return <i key={d.day} className={tone} title={`${new Date(d.day * 86400000).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })}: ${total ? `${Math.round((d.up / total) * 1000) / 10}% up` : "no data"}`} />;
      })}
    </span>
  );
}

export const fmtPct = (n: number | null | undefined) => n === null || n === undefined ? "–" : `${n >= 99.995 || n === 0 ? Math.round(n) : n.toFixed(n >= 99 ? 2 : 1).replace(/\.?0+$/, "")}%`;
export const fmtMs = (n: number | null | undefined) => n === null || n === undefined ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`;

/** The overall state of a set of monitors, for a group heading. */
export function groupState(rows: Array<{ state: MonitorState }>): MonitorState {
  const live = rows.filter(r => r.state !== "paused");
  if (!live.length) return "paused";
  if (live.some(r => r.state === "down")) return "down";
  if (live.some(r => r.state === "pending")) return "pending";
  if (live.every(r => r.state === "maintenance")) return "maintenance";
  if (live.every(r => r.state === "unknown")) return "unknown";
  return "up";
}

/** Rows split by group name, groups in the order they first appear; monitors with no group come last under an empty name. */
export function groupRows<T extends { group: string }>(rows: T[]): Array<{ name: string; rows: T[] }> {
  const map = new Map<string, T[]>();
  for (const r of rows) { const k = r.group || ""; map.set(k, [...(map.get(k) ?? []), r]); }
  const named = [...map.entries()].filter(([k]) => k).map(([name, rs]) => ({ name, rows: rs }));
  return map.has("") ? [...named, { name: "", rows: map.get("")! }] : named;
}

/** Response times as a line, with a red band where the service was down. Axis labels give the range, so no bar is unlabelled. */
export function ResponseChart({ points, hours }: { points: Array<{ t: number; ms: number | null; down: boolean }>; hours: number }) {
  const W = 640, H = 150, L = 44, R = 8, T = 8, B = 20;
  const now = Date.now(), from = now - hours * 3600_000;
  const shown = points.filter(p => p.t >= from);
  const vals = shown.map(p => p.ms).filter((v): v is number => v !== null);
  if (!shown.length) return <p className="sub">No checks in this period yet.</p>;
  const max = Math.max(10, ...vals) * 1.15;
  const x = (t: number) => L + ((t - from) / (now - from)) * (W - L - R);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  let d = ""; let pen = false;
  for (const p of shown) { if (p.ms === null) { pen = false; continue; } d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.ms).toFixed(1)}`; pen = true; }
  const step = Math.max(1, (now - from) / Math.max(1, shown.length));
  const fmtT = (t: number) => hours <= 48 ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  return (
    <svg className="mchart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Response time over the last ${hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`}`}>
      {[0, 0.5, 1].map(f => <g key={f}><line x1={L} x2={W - R} y1={y(max / 1.15 * f)} y2={y(max / 1.15 * f)} className="grid" /><text x={L - 6} y={y(max / 1.15 * f) + 4} textAnchor="end">{fmtMs(Math.round(max / 1.15 * f))}</text></g>)}
      {shown.filter(p => p.down).map(p => <rect key={p.t} x={x(p.t) - Math.max(1, step / 2 * ((W - L - R) / (now - from)))} y={T} width={Math.max(2, step * ((W - L - R) / (now - from)))} height={H - T - B} className="down" />)}
      <path d={d} className="line" />
      {shown.length < 40 && shown.filter(p => p.ms !== null).map(p => <circle key={p.t} cx={x(p.t)} cy={y(p.ms as number)} r={3} className="dot" />)}
      <text x={L} y={H - 4}>{fmtT(from)}</text><text x={W - R} y={H - 4} textAnchor="end">{fmtT(now)}</text>
    </svg>
  );
}

export const KIND_LABEL: Record<string, string> = { http: "Website", keyword: "Keyword", json: "JSON", tcp: "Port", ping: "Ping", dns: "DNS", cert: "Certificate", push: "Heartbeat", docker: "Docker", postgres: "PostgreSQL", mysql: "MySQL", mongodb: "MongoDB", redis: "Redis", mssql: "SQL Server", group: "Group" };

/** Monitors in tree order: each group monitor is followed by what is inside it, with how deep that is. A monitor whose parent is not in the list stands on its own. */
export function flattenTree<T extends { id: string; parentId: string }>(rows: T[]): Array<{ item: T; depth: number }> {
  const ids = new Set(rows.map(r => r.id)), kids = new Map<string, T[]>(), roots: T[] = [];
  for (const r of rows) {
    if (r.parentId && r.parentId !== r.id && ids.has(r.parentId)) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]); else roots.push(r);
  }
  const out: Array<{ item: T; depth: number }> = [], seen = new Set<string>();
  const walk = (r: T, depth: number) => { if (seen.has(r.id)) return; seen.add(r.id); out.push({ item: r, depth }); for (const k of kids.get(r.id) ?? []) walk(k, depth + 1); };
  roots.forEach(r => walk(r, 0));
  rows.forEach(r => walk(r, 0));
  return out;
}

/** Sections by the text group of each top-level monitor; whatever sits inside a group monitor stays with it. */
export function groupTree<T extends { id: string; parentId: string; group: string }>(rows: T[]): Array<{ name: string; rows: Array<{ item: T; depth: number }> }> {
  const flat = flattenTree(rows), sections = new Map<string, Array<{ item: T; depth: number }>>();
  let current = "";
  for (const f of flat) { if (f.depth === 0) current = f.item.group || ""; sections.set(current, [...(sections.get(current) ?? []), f]); }
  const named = [...sections.entries()].filter(([k]) => k).map(([name, rs]) => ({ name, rows: rs }));
  return sections.has("") ? [...named, { name: "", rows: sections.get("")! }] : named;
}

/** How many of the monitors directly inside a group monitor are up. */
export function childCounts(rows: Array<{ id: string; parentId: string; state: MonitorState }>, id: string): { up: number; total: number } {
  const kids = rows.filter(r => r.parentId === id && r.state !== "paused");
  return { up: kids.filter(r => r.state === "up").length, total: kids.length };
}
