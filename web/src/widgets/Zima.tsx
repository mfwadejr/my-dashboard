import type { ReactNode } from "react";
import type { WidgetProps } from "./types";
import { Bar, Empty, Pill } from "./common";
import { Gauge } from "./Gauge";
import { Shell, bytes, pct } from "./Shell";
import { resolveSections } from "./sections";
import { useSeries } from "../hooks";

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

const speed = (bps: number | null | undefined) => (typeof bps !== "number" ? "–" : bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);

/** Upload and download on one shared scale, drawn from the connection's recorded history. */
function Network({ net, integrationId, tall }: { net: any; integrationId?: string; tall: boolean }) {
  const up = useSeries(integrationId, "net_up_bps", 60), down = useSeries(integrationId, "net_down_bps", 60);
  const h = tall ? 64 : 40;
  const all = [...up, ...down];
  const x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0])), y1 = Math.max(...all.map(p => p[1]), 1);
  const line = (pts: Array<[number, number]>) => pts.map(([x, y]) => `${(((x - x0) / (x1 - x0 || 1)) * 200).toFixed(1)},${(h - (y / y1) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return (
    <div className="net">
      <div className="row sp"><span className="sub">Network · {net.iface}</span><span className="sub"><span style={{ color: "var(--accent)" }}>↑</span> {speed(net.upBps)} · <span style={{ color: "var(--ok)" }}>↓</span> {speed(net.downBps)}</span></div>
      {up.length > 1 && down.length > 1
        ? <svg className="spark" viewBox={`0 0 200 ${h}`} preserveAspectRatio="none" style={{ height: h }}><polyline points={line(down)} fill="none" stroke="var(--ok)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" /><polyline points={line(up)} fill="none" stroke="var(--accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" /></svg>
        : <div className="sparkline-empty" style={{ height: h }}>collecting history…</div>}
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
