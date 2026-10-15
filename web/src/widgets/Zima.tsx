import type { ReactNode } from "react";
import type { WidgetProps } from "./types";
import { Bar, Empty, Pill } from "./common";
import { Gauge } from "./Gauge";
import { Shell, bytes, pct } from "./Shell";
import { resolveSections } from "./sections";
import { useFastSamples } from "../hooks";

function StateList({ rows, none }: { rows: Array<{ name: string; sub?: string | null; state: string | null; running: boolean; hint?: string; id?: string | null }>; none: string }) {
  if (rows.length === 0) return <Empty>{none}</Empty>;
  return (
    <div className="list">{rows.map((r, i) => (
      <div key={`${r.name}${i}`} className="li" title={[r.id && r.id !== r.name ? `id: ${r.id}` : "", r.hint ? `ZimaOS sent: ${r.hint}` : ""].filter(Boolean).join(" · ") || undefined}>
        <span className="trunc">{r.name}{r.sub ? <span className="sub"> · {r.sub}</span> : null}</span>
        <Pill tone={r.running ? "ok" : "mute"}>{r.state ?? (r.running ? "running" : "stopped")}</Pill>
      </div>
    ))}</div>
  );
}

const fmt = (bps: number | null | undefined, unit: "kB" | "MB") => (typeof bps !== "number" ? "–" : unit === "MB" ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);

/** A 1-2-5 step so the grid lines land on round numbers, like ZimaOS's own graph. */
function niceScale(max: number): { top: number; step: number } {
  const raw = Math.max(max, 1) / 3, pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find(m => m * pow >= raw) ?? 10) * pow;
  return { top: step * 3, step };
}

/** Smooth curve through the points (Catmull-Rom converted to cubic segments). */
function smooth(pts: Array<[number, number]>, lo = -Infinity, hi = Infinity): string {
  const c = (y: number) => Math.max(lo, Math.min(hi, y));
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${c(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${c(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Live upload and download, sampled every couple of seconds while this tile is on screen. */
function Network({ net, integrationId, tall }: { net: any; integrationId?: string; tall: boolean }) {
  return <NetChart net={net} points={useFastSamples(integrationId, true, 60)} tall={tall} />;
}

export function NetChart({ net, points, tall }: { net: any; points: Array<{ t: number; v: Record<string, number | null> }>; tall: boolean }) {
  const rows = points.filter(p => typeof p.v.up === "number" && typeof p.v.down === "number");
  const last = rows[rows.length - 1];
  const upNow = last ? last.v.up : net.upBps, downNow = last ? last.v.down : net.downBps;
  const peak = Math.max(...rows.map(r => Math.max(r.v.up as number, r.v.down as number)), 0);
  const unit: "kB" | "MB" = peak >= 1e6 ? "MB" : "kB";
  const div = unit === "MB" ? 1e6 : 1e3;
  const { top, step } = niceScale(peak / div);
  const W = 400, H = tall ? 150 : 100, L = 34, B = 6, T = 8, R = 4;
  const offset = 60 - rows.length;
  const px = (i: number) => L + ((i + offset) / 59) * (W - L - R);
  const py = (v: number) => T + (1 - Math.min(v / div, top) / top) * (H - T - B);
  const series = (key: "up" | "down") => rows.map((r, i) => [px(i), py(r.v[key] as number)] as [number, number]);
  const area = (pts: Array<[number, number]>) => `${smooth(pts, T, H - B)}L${pts[pts.length - 1][0].toFixed(1)} ${H - B}L${pts[0][0].toFixed(1)} ${H - B}Z`;
  const up = series("up"), down = series("down");
  return (
    <div className="net">
      <div className="row sp"><span className="sub">Network</span><b>{net.iface}</b></div>
      {rows.length > 1 ? (
        <svg className="netchart" viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Live network speed">
          {[0, 1, 2, 3].map(i => { const v = step * i, y = py(v * div); return <g key={i}><line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--line)" strokeWidth="1" /><text x={L - 6} y={y + 4} textAnchor="end" fontSize="11" fill="var(--mute)">{Math.round(v * 10) / 10}</text></g>; })}
          <path d={area(down)} fill="var(--ok)" opacity=".18" /><path d={smooth(down, T, H - B)} fill="none" stroke="var(--ok)" strokeWidth="1.8" />
          <path d={area(up)} fill="var(--accent)" opacity=".18" /><path d={smooth(up, T, H - B)} fill="none" stroke="var(--accent)" strokeWidth="1.8" />
        </svg>
      ) : <div className="sparkline-empty" style={{ height: tall ? 120 : 80 }}>collecting live data…</div>}
      <div className="row" style={{ gap: 14 }}>
        <span className="sub">{unit}</span>
        <span className="sub"><span style={{ color: "var(--accent)" }}>↑</span> {fmt(upNow, unit)}</span>
        <span className="sub"><span style={{ color: "var(--ok)" }}>↓</span> {fmt(downNow, unit)}</span>
      </div>
    </div>
  );
}

const SECTIONS: Record<string, (d: any, props: WidgetProps) => ReactNode> = {
  summary: d => (d.cpu || d.mem) && (
    <div className="gauges">
      <Gauge pct={d.cpu?.pct} label="CPU" hot={d.cpu?.tempC > 80}
        detail={[d.cpu?.powerW != null && `${d.cpu.powerW.toFixed(1)} W`, d.cpu?.tempC != null && `${Math.round(d.cpu.tempC)}°C`].filter(Boolean).join(" / ") || undefined} />
      <Gauge pct={d.mem?.pct} label="RAM" warn={80} detail={d.mem?.usedB != null ? `${bytes(d.mem.usedB)}${d.mem.totalB ? ` of ${bytes(d.mem.totalB)}` : ""}` : undefined} />
    </div>
  ),
  network: (d, props) => d.net && <Network net={d.net} integrationId={props.tile.config.integrationId as string | undefined} tall={props.tile.h >= 3} />,
  systemdisk: d => d.systemDisk && (
    <div><div className="row sp"><span className="sub">System disk {d.systemDisk.pct}%</span><span className="sub">{bytes(d.systemDisk.usedB)} of {bytes(d.systemDisk.totalB)}</span></div><Bar value={d.systemDisk.pct / 100} tone={d.systemDisk.pct > 90 ? "warn" : undefined} /></div>
  ),
  appcount: d => d.apps?.known && <div className="sub">{d.apps.running}/{d.apps.total} apps running</div>,
  apps: d => d.appList && <StateList rows={d.appList} none="ZimaOS lists no apps" />,
  containers: d => d.containers === null ? <Empty>ZimaOS did not share a container list</Empty> : <StateList rows={d.containers.map((c: any) => ({ ...c, sub: c.image }))} none="No containers" />,
  vms: d => d.vms === null ? <Empty>ZimaOS did not share a VM list</Empty> : <StateList rows={d.vms} none="No virtual machines" />,
  disks: d => d.disks?.length > 0 && (
    <div className="list">{d.disks.map((x: any) => (
      <div key={x.name} className="li"><span className="trunc">{x.name}{x.model ? <span className="sub"> · {x.model}</span> : null}</span><span className="sub">{bytes(x.sizeB)}{x.tempC != null ? ` · ${x.tempC}°C` : ""}</span></div>
    ))}</div>
  )
};

export function Zima(props: WidgetProps) {
  const sections = resolveSections("zimaos", props.tile.config.sections).filter(s => s.on);
  return (
    <Shell props={props} label="ZimaOS">{d => (
      <>
        <div className="row sp">
          <span className="sub">{d.device ?? "ZimaOS"}{d.version ? ` ${d.version}` : ""}</span>
          {d.needUpdate && <Pill tone="warn">update {d.latest ?? ""}</Pill>}
        </div>
        {sections.map(s => { const node = SECTIONS[s.id]?.(d, props); return node ? <div key={s.id} className="usec">{node}</div> : null; })}
        {!d.cpu && !d.mem && <Empty>Logged in, but this system did not report CPU or memory.</Empty>}
      </>
    )}</Shell>
  );
}
