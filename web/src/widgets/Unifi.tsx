import type { ReactNode } from "react";
import type { WidgetProps } from "./types";
import { resolveSections } from "./sections";
import { Bar, Empty, Pill } from "./common";
import { Shell, pct, rate, uptime } from "./Shell";

const state = (v: string) => v.toLowerCase().replace(/_/g, " ");

function Rows({ rows }: { rows: Array<{ key: string; left: string; right: ReactNode }> }) {
  return <div className="list">{rows.map(r => <div key={r.key} className="li"><span className="trunc">{r.left}</span><span className="sub">{r.right}</span></div>)}</div>;
}

const SECTIONS: Record<string, (d: any) => ReactNode> = {
  summary: d => (
    <div className="stats3">
      <div><b>{d.clients ? d.clients.total : "–"}</b><span>clients</span></div>
      <div><b className={d.devices?.offline ? "warn" : ""}>{d.devices ? `${d.devices.online}/${d.devices.total}` : "–"}</b><span>devices up</span></div>
      <div><b>{d.clients?.wireless ?? "–"}</b><span>wireless</span></div>
    </div>
  ),
  gateway: d => d.gateway && (
    <>
      <div className="row sp"><span className="sub">{d.gateway.name}</span><span className="sub">{[d.gateway.tempC !== null && d.gateway.tempC !== undefined && `${Math.round(d.gateway.tempC)}°C`, `up ${uptime(d.gateway.uptimeSec)}`].filter(Boolean).join(" · ")}</span></div>
      <div className="row sp"><span className="sub">CPU {pct(d.gateway.cpuPct)}</span><div style={{ flex: 1 }}><Bar value={(d.gateway.cpuPct ?? 0) / 100} tone={d.gateway.cpuPct > 85 ? "bad" : undefined} /></div></div>
      <div className="row sp"><span className="sub">RAM {pct(d.gateway.memPct)}</span><div style={{ flex: 1 }}><Bar value={(d.gateway.memPct ?? 0) / 100} tone={d.gateway.memPct > 90 ? "warn" : undefined} /></div></div>
      <div className="row sp"><span className="sub">↓ {rate(d.gateway.rxBps)}</span><span className="sub">↑ {rate(d.gateway.txBps)}</span></div>
    </>
  ),
  wans: d => d.wans && (d.wans.length === 0 ? <Empty>No WAN information from UniFi</Empty> : (
    <div className="list">{d.wans.map((w: any, i: number) => (
      <div key={`${w.name}${i}`} className="wan">
        <div className="row sp"><b className="trunc">{w.name}</b>{w.up === null ? null : <Pill tone={w.up ? "ok" : "bad"}>{w.up ? "up" : "down"}</Pill>}</div>
        <div className="row sp"><span className="sub">↓ {rate(w.rxBps)}</span><span className="sub">↑ {rate(w.txBps)}</span></div>
        {(w.ip || w.speedMbps) && <div className="sub">{[w.ip, w.speedMbps ? `${w.speedMbps} Mbps link` : ""].filter(Boolean).join(" · ")}</div>}
      </div>
    ))}</div>
  )),
  speedtest: d => d.speedtest && (
    <div className="row sp"><span className="sub">Speed test</span><span className="sub">↓ {d.speedtest.downMbps?.toFixed(0) ?? "–"} · ↑ {d.speedtest.upMbps?.toFixed(0) ?? "–"} Mbps{d.speedtest.latencyMs ? ` · ${Math.round(d.speedtest.latencyMs)} ms` : ""}</span></div>
  ),
  aps: d => d.aps?.length > 0 && <Rows rows={d.aps.map((a: any, i: number) => ({ key: `${a.name}${i}`, left: a.name, right: a.state.toUpperCase() === "ONLINE" ? (a.clients === null ? "online" : `${a.clients} clients`) : state(a.state) }))} />,
  wifi: d => d.wifi?.length > 0 && <Rows rows={d.wifi.map((w: any, i: number) => ({ key: `${w.name}${i}`, left: w.name, right: w.enabled ? w.security || "on" : "disabled" }))} />,
  networks: d => d.networks?.length > 0 && <Rows rows={d.networks.map((n: any, i: number) => ({ key: `${n.name}${i}`, left: n.name, right: [n.vlan !== null && n.vlan !== undefined ? `VLAN ${n.vlan}` : "", n.enabled ? "" : "disabled"].filter(Boolean).join(" · ") || "default" }))} />,
  devices: d => d.deviceList?.length > 0 && <Rows rows={d.deviceList.map((x: any, i: number) => ({ key: `${x.name}${i}`, left: x.name, right: x.state.toUpperCase() !== "ONLINE" ? state(x.state) : x.updatable ? "update available" : x.firmware || "online" }))} />,
  problems: d => d.devices && (d.devices.problems.length > 0
    ? <div className="list">{d.devices.problems.map((p: any) => <div key={p.name} className="li"><span className="trunc">{p.name}</span><Pill tone="bad">{state(p.state)}</Pill></div>)}</div>
    : <Empty>All devices online</Empty>)
};

export function UnifiNetwork(props: WidgetProps) {
  const sections = resolveSections("unifi-network", props.tile.config.sections).filter(s => s.on);
  return (
    <Shell props={props} label="UniFi Network">{d => (
      <>
        {sections.map(s => { const node = SECTIONS[s.id]?.(d); return node ? <div key={s.id} className="usec">{node}</div> : null; })}
        {sections.length === 0 && <Empty>Turn on sections in this tile's settings.</Empty>}
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
