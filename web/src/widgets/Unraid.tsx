import type { WidgetProps } from "./types";
import { Bar, Empty, Pill } from "./common";
import { Shell, bytes, pct } from "./Shell";

const arrayTone = (s: string) => (s === "STARTED" ? "ok" : s ? "warn" : "mute");

export function Unraid(props: WidgetProps) {
  const tall = props.tile.h >= 3;
  return (
    <Shell props={props} label="Unraid">{d => (
      <>
        <div className="row sp">
          <span className="sub">{d.host?.name ?? ""}</span>
          <span className="row">
            {d.array && <Pill tone={arrayTone(d.array.state)}>array {d.array.state.toLowerCase()}</Pill>}
            {d.array?.check?.running && <Pill tone="warn">parity {Math.round(d.array.check.progress ?? 0)}%</Pill>}
          </span>
        </div>
        {d.array?.usedPct != null && (
          <div><div className="row sp"><span className="sub">Array {d.array.usedPct}%</span><span className="sub">{bytes((d.array.usedKB ?? 0) * 1000)} of {bytes((d.array.totalKB ?? 0) * 1000)}</span></div><Bar value={d.array.usedPct / 100} tone={d.array.usedPct > 95 ? "bad" : d.array.usedPct > 85 ? "warn" : undefined} /></div>
        )}
        {(d.cpuPct != null || d.mem) && (
          <div className="stats3">
            <div><b>{pct(d.cpuPct)}</b><span>CPU</span></div>
            <div><b>{pct(d.mem?.pct)}</b><span>RAM</span></div>
            <div><b className={d.array?.hottest > 50 ? "warn" : ""}>{d.array?.hottest ? `${d.array.hottest}°` : "–"}</b><span>hottest disk</span></div>
          </div>
        )}
        <div className="row" style={{ flexWrap: "wrap" }}>
          {d.docker && <Pill tone={d.docker.running === d.docker.total ? "ok" : "warn"}>{d.docker.running}/{d.docker.total} containers</Pill>}
          {d.docker?.updates > 0 && <Pill tone="warn">{d.docker.updates} update{d.docker.updates === 1 ? "" : "s"}</Pill>}
          {d.vms && <Pill>{d.vms.running}/{d.vms.total} VMs</Pill>}
          {d.notifications?.alert > 0 && <Pill tone="bad">{d.notifications.alert} alert{d.notifications.alert === 1 ? "" : "s"}</Pill>}
          {d.notifications?.warning > 0 && <Pill tone="warn">{d.notifications.warning} warning{d.notifications.warning === 1 ? "" : "s"}</Pill>}
          {d.array?.diskProblems > 0 && <Pill tone="bad">{d.array.diskProblems} disk problem{d.array.diskProblems === 1 ? "" : "s"}</Pill>}
        </div>
        {tall && d.array?.disks.length > 0 && (
          <div className="list">
            {d.array.disks.map((x: any) => (
              <div key={`${x.kind}-${x.name}`} className="li">
                <span className="trunc">{x.name}{x.kind !== "data" && x.kind !== x.name ? <span className="sub"> · {x.kind}</span> : null}</span>
                <span className="row"><span className="sub">{x.usedPct != null ? `${x.usedPct}%` : ""}</span><span className={x.tempC > 50 ? "pill warn" : "sub"}>{x.tempC != null ? `${x.tempC}°C` : x.spinning === false ? "standby" : ""}</span></span>
              </div>
            ))}
          </div>
        )}
        {tall && d.docker?.stopped.length > 0 && <div className="sub">Stopped: {d.docker.stopped.join(", ")}</div>}
        {!d.array && !d.docker && <Empty>This key could not read the array or Docker.</Empty>}
      </>
    )}</Shell>
  );
}
