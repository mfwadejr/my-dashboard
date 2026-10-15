import type { WidgetProps } from "./types";
import { Bar, Empty, Pill } from "./common";
import { Shell, pct, rate, uptime } from "./Shell";

export function UnifiNetwork(props: WidgetProps) {
  return (
    <Shell props={props} label="UniFi Network">{d => (
      <>
        <div className="stats3">
          <div><b>{d.clients ? d.clients.total : "–"}</b><span>clients</span></div>
          <div><b className={d.devices?.offline ? "warn" : ""}>{d.devices ? `${d.devices.online}/${d.devices.total}` : "–"}</b><span>devices up</span></div>
          <div><b>{d.clients?.wireless ?? "–"}</b><span>wireless</span></div>
        </div>
        {d.gateway && props.tile.h >= 2 && (
          <>
            <div className="row sp"><span className="sub">{d.gateway.name}</span><span className="sub">up {uptime(d.gateway.uptimeSec)}</span></div>
            <div className="row sp"><span className="sub">CPU {pct(d.gateway.cpuPct)}</span><div style={{ flex: 1 }}><Bar value={(d.gateway.cpuPct ?? 0) / 100} tone={d.gateway.cpuPct > 85 ? "bad" : undefined} /></div></div>
            <div className="row sp"><span className="sub">RAM {pct(d.gateway.memPct)}</span><div style={{ flex: 1 }}><Bar value={(d.gateway.memPct ?? 0) / 100} tone={d.gateway.memPct > 90 ? "warn" : undefined} /></div></div>
            <div className="row sp"><span className="sub">↓ {rate(d.gateway.rxBps)}</span><span className="sub">↑ {rate(d.gateway.txBps)}</span></div>
          </>
        )}
        {props.tile.h >= 3 && d.devices?.problems.length > 0 && (
          <div className="list">{d.devices.problems.map((p: any) => <div key={p.name} className="li"><span className="trunc">{p.name}</span><Pill tone="bad">{p.state.toLowerCase().replace(/_/g, " ")}</Pill></div>)}</div>
        )}
        {props.tile.h >= 3 && d.devices?.problems.length === 0 && <Empty>All devices online</Empty>}
      </>
    )}</Shell>
  );
}

export function UnifiProtect(props: WidgetProps) {
  return (
    <Shell props={props} label="UniFi Protect">{d => (
      <>
        <div className="stats3">
          <div><b>{d.cameras.total}</b><span>cameras</span></div>
          <div><b className={d.cameras.disconnected ? "warn" : ""}>{d.cameras.connected}</b><span>connected</span></div>
          <div><b>{d.others.sensors ?? "–"}</b><span>sensors</span></div>
        </div>
        {d.nvr && <div className="sub">{d.nvr}</div>}
        {d.cameras.disconnected > 0 && (
          <div className="list">{d.cameras.problems.map((p: any) => <div key={p.name} className="li"><span className="trunc">{p.name}</span><Pill tone="bad">{p.state.toLowerCase()}</Pill></div>)}</div>
        )}
        {d.cameras.disconnected === 0 && props.tile.h >= 2 && <Empty>All cameras connected</Empty>}
      </>
    )}</Shell>
  );
}
