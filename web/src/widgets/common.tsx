import { useEffect, useRef, type ReactNode } from "react";

export const initials = (name: string) => name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";

export function Title({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <h4>{children}{right ? <span className="right">{right}</span> : null}</h4>;
}

export function Bar({ value, tone }: { value: number; tone?: "ok" | "warn" | "bad" }) {
  return <div className="bar"><i className={tone} style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} /></div>;
}

export function Pill({ children, tone }: { children: ReactNode; tone?: "ok" | "warn" | "bad" | "mute" }) {
  return <span className={`pill ${tone ?? ""}`}>{children}</span>;
}

export function Live({ ok, stale }: { ok: boolean; stale?: boolean }) {
  return <span className={`live ${ok ? "" : "off"}`}>{ok ? "live" : stale ? "stale" : "offline"}</span>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty-note">{children}</div>; }

export function Sparkline({ points, height = 46 }: { points: Array<[number, number]>; height?: number }) {
  if (points.length < 2) return <div className="sparkline-empty" style={{ height }}>collecting history…</div>;
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y1 = Math.max(...ys, 1);
  const pts = points.map(([x, y]) => `${(((x - x0) / (x1 - x0 || 1)) * 200).toFixed(1)},${(height - (y / y1) * (height - 4) - 2).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 200 ${height}`} preserveAspectRatio="none" style={{ height }}>
      <polyline points={`0,${height} ${pts} 200,${height}`} className="spark-fill" />
      <polyline points={pts} className="spark-line" />
    </svg>
  );
}

export function useTick(ms: number, fn: () => void) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => { const t = window.setInterval(() => saved.current(), ms); return () => window.clearInterval(t); }, [ms]);
}

export function formatSpeed(kbs: number): string {
  if (kbs >= 1024) return `${(kbs / 1024).toFixed(1)} MB/s`;
  return `${Math.round(kbs)} KB/s`;
}

export function formatSize(mb: number): string {
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function relDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((d.getTime() - Date.now()) / 86400_000);
  const day = days <= 0 && d.toDateString() === new Date().toDateString() ? "Today" : days === 1 || (days === 0) ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return day;
}
