import type { WidgetProps } from "./types";
import { Bar, Empty, Pill } from "./common";
import { Shell, bytes, pct } from "./Shell";

export function Zima(props: WidgetProps) {
  const tall = props.tile.h >= 3;
  return (
    <Shell props={props} label="ZimaOS">{d => (
      <>
        <div className="row sp">
          <span className="sub">{d.device ?? "ZimaOS"}{d.version ? ` ${d.version}` : ""}</span>
          {d.needUpdate && <Pill tone="warn">update {d.latest ?? ""}</Pill>}
        </div>
        <div className="stats3">
          <div><b>{pct(d.cpu?.pct)}</b><span>CPU</span></div>
          <div><b>{pct(d.mem?.pct)}</b><span>RAM</span></div>
          <div><b className={d.cpu?.tempC > 80 ? "warn" : ""}>{d.cpu?.tempC != null ? `${Math.round(d.cpu.tempC)}°` : "–"}</b><span>CPU temp</span></div>
        </div>
        {d.mem?.pct != null && <Bar value={d.mem.pct / 100} tone={d.mem.pct > 90 ? "warn" : undefined} />}
        {d.systemDisk && <div><div className="row sp"><span className="sub">System disk {d.systemDisk.pct}%</span><span className="sub">{bytes(d.systemDisk.usedB)} of {bytes(d.systemDisk.totalB)}</span></div><Bar value={d.systemDisk.pct / 100} tone={d.systemDisk.pct > 90 ? "warn" : undefined} /></div>}
        {d.apps?.known && <div className="sub">{d.apps.running}/{d.apps.total} apps running</div>}
        {tall && d.disks.length > 0 && (
          <div className="list">
            {d.disks.map((x: any) => (
              <div key={x.name} className="li"><span className="trunc">{x.name}{x.model ? <span className="sub"> · {x.model}</span> : null}</span><span className="sub">{bytes(x.sizeB)}{x.tempC != null ? ` · ${x.tempC}°C` : ""}</span></div>
            ))}
          </div>
        )}
        {!d.cpu && !d.mem && <Empty>Logged in, but this system did not report CPU or memory.</Empty>}
      </>
    )}</Shell>
  );
}
