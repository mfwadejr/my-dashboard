import type { ReactNode } from "react";
import type { WidgetProps } from "./types";
import { Bar, Empty, Pill } from "./common";
import { Gauge } from "./Gauge";
import { Shell, bytes, pct } from "./Shell";
import { resolveSections } from "./sections";

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

const SECTIONS: Record<string, (d: any) => ReactNode> = {
  summary: d => (d.cpu || d.mem) && (
    <div className="gauges">
      <Gauge pct={d.cpu?.pct} label="CPU" hot={d.cpu?.tempC > 80}
        detail={[d.cpu?.powerW != null && `${d.cpu.powerW.toFixed(1)} W`, d.cpu?.tempC != null && `${Math.round(d.cpu.tempC)}°C`].filter(Boolean).join(" / ") || undefined} />
      <Gauge pct={d.mem?.pct} label="RAM" warn={80} detail={d.mem?.usedB != null ? `${bytes(d.mem.usedB)}${d.mem.totalB ? ` of ${bytes(d.mem.totalB)}` : ""}` : undefined} />
    </div>
  ),
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
        {sections.map(s => { const node = SECTIONS[s.id]?.(d); return node ? <div key={s.id} className="usec">{node}</div> : null; })}
        {!d.cpu && !d.mem && <Empty>Logged in, but this system did not report CPU or memory.</Empty>}
      </>
    )}</Shell>
  );
}
