import type { ReactNode } from "react";
import type { WidgetProps } from "./types";
import { resolveSections } from "./sections";
import { Bar, Empty, Pill } from "./common";
import { Gauge } from "./Gauge";
import { Shell, bytes, pct, rate, uptime } from "./Shell";
import { useFastSamples } from "../hooks";

const state = (v: string) => v.toLowerCase().replace(/_/g, " ");

function Rows({ rows }: { rows: Array<{ key: string; left: string; right: ReactNode }> }) {
  return <div className="list">{rows.map(r => <div key={r.key} className="li"><span className="trunc">{r.left}</span><span className="sub">{r.right}</span></div>)}</div>;
}

/** One row per internet link: live rates (sampled every few seconds while this tile is on screen), link state, active link, latency and availability. */
function Wans({ d, id }: { d: any; id?: string }) {
  const points = useFastSamples(id, Boolean(id) && d.wans?.length > 0, 3);
  const live = points[points.length - 1]?.v;
  if (d.wans.length === 0) return <Empty>No WAN information from UniFi</Empty>;
  const failover = d.wans.length > 1;
  return (
    <div className="list">
      {d.publicIp && <div className="row sp"><span className="sub">Public address</span><span className="sub">{d.publicIp}</span></div>}
      {d.wans.map((w: any, i: number) => {
        const rx = live && typeof live[`wan${i + 1}_rx_bps`] === "number" ? live[`wan${i + 1}_rx_bps`] : w.rxBps;
        const tx = live && typeof live[`wan${i + 1}_tx_bps`] === "number" ? live[`wan${i + 1}_tx_bps`] : w.txBps;
        const health = [w.latencyMs !== null && w.latencyMs !== undefined ? `${Math.round(w.latencyMs)} ms` : "", w.availabilityPct !== null && w.availabilityPct !== undefined ? `${w.availabilityPct.toFixed(w.availabilityPct >= 99.95 ? 0 : 1)}% available` : ""].filter(Boolean);
        return (
          <div key={`${w.name}${i}`} className="wan">
            <div className="row sp">
              <b className="trunc">{w.name}</b>
              <span className="row">
                {failover && w.active !== null && w.active !== undefined && <Pill tone={w.active ? "ok" : "mute"}>{w.active ? "active" : "standby"}</Pill>}
                {w.up === null ? null : <Pill tone={w.up ? "ok" : "bad"}>{w.up ? "up" : "down"}</Pill>}
              </span>
            </div>
            <div className="row sp"><span className="sub">↓ {rate(rx)}</span><span className="sub">↑ {rate(tx)}</span></div>
            {(w.ip || w.speedMbps) && <div className="sub">{[w.ip, w.speedMbps ? `${w.speedMbps} Mbps link` : ""].filter(Boolean).join(" · ")}</div>}
            {health.length > 0 ? <div className="sub">{health.join(" · ")}</div> : failover && <div className="sub">Latency and availability not reported for this link</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Values the owner picked in the field picker, formatted by the unit chosen there. */
function fmtField(value: unknown, unit: string): string {
  if (value === null || value === undefined) return "–";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value || "–";
  const n = value as number;
  switch (unit) {
    case "bytesps": return rate(n * 8);
    case "bps": return rate(n);
    case "bytes": return bytes(n);
    case "percent": return `${Math.round(n * 10) / 10}%`;
    case "temp": return `${Math.round(n)}°C`;
    case "duration": return uptime(n);
    case "ms": return `${Math.round(n)} ms`;
    case "mbps": return `${Math.round(n)} Mbps`;
    case "dbm": return `${Math.round(n)} dBm`;
    default: return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }
}

function Custom({ d }: { d: any }) {
  return (
    <div className="list">
      {d.custom.map((f: any) => <div key={f.path} className="li"><span className="trunc" title={f.path}>{f.label}</span><span className="sub">{fmtField(f.value, f.unit)}</span></div>)}
      {d.customNotes?.length > 0 && <div className="sub">{d.customNotes.join(" · ")}</div>}
    </div>
  );
}

const SECTIONS: Record<string, (d: any, id?: string) => ReactNode> = {
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
      <div className="row sp"><span className="sub">CPU {pct(d.gateway.cpuPct)}</span><div className="f1"><Bar value={(d.gateway.cpuPct ?? 0) / 100} tone={d.gateway.cpuPct > 85 ? "bad" : undefined} /></div></div>
      <div className="row sp"><span className="sub">RAM {pct(d.gateway.memPct)}</span><div className="f1"><Bar value={(d.gateway.memPct ?? 0) / 100} tone={d.gateway.memPct > 90 ? "warn" : undefined} /></div></div>
      <div className="row sp"><span className="sub">↓ {rate(d.gateway.rxBps)}</span><span className="sub">↑ {rate(d.gateway.txBps)}</span></div>
    </>
  ),
  wans: (d, id) => d.wans && <Wans d={d} id={id} />,
  custom: d => d.custom?.length > 0 && <Custom d={d} />,
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
  const id = props.tile.config.integrationId as string | undefined;
  return (
    <Shell props={props} label="UniFi Network">{d => (
      <>
        {sections.map(s => { const node = SECTIONS[s.id]?.(d, id); return node ? <div key={s.id} className="usec">{node}</div> : null; })}
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

export function UnifiUnas(props: WidgetProps) {
  return (
    <Shell props={props} label="UniFi UNAS">{d => {
      const st = d.storage;
      if (!st) return <Empty>Signed in, but this UNAS did not share storage numbers in a format Homebase knows yet. Run Test on the connection and send me the result.</Empty>;
      const used = Math.round((st.usedB / st.totalB) * 100);
      const ok = !st.status || /^(ok|healthy|normal|online|good|optimal|active)/i.test(st.status);
      return (
        <>
          <div className="row sp"><span className="sub">{d.name ?? "UNAS"}</span>{st.status && <Pill tone={ok ? "ok" : "bad"}>{st.status.toLowerCase()}</Pill>}</div>
          <div className="gauges"><Gauge pct={used} label="Used" warn={80} bad={92} detail={`${bytes(st.usedB)} of ${bytes(st.totalB)}`} /></div>
          {st.availB != null && <div className="sub tc">{bytes(st.availB)} free</div>}
        </>
      );
    }}</Shell>
  );
}
