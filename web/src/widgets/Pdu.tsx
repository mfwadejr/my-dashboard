import type { WidgetProps } from "./types";
import { Bar, Empty, Pill } from "./common";
import { Shell, uptime } from "./Shell";

export function Pdu(props: WidgetProps) {
  return (
    <Shell props={props} label="UniFi PDU">{d => (
      !d.pdus ? <Empty>Waiting for the next refresh…</Empty> : d.pdus.length === 0 ? <Empty>No PDU is adopted in this site.</Empty> :
      <div className="list">
        {d.pdus.map((p: any) => (
          <div key={p.id} className="pdu">
            <div className="row sp"><b className="trunc">{p.name}</b><Pill tone={p.state === "ONLINE" ? "ok" : "bad"}>{p.state.toLowerCase().replace(/_/g, " ")}</Pill></div>
            <div className="row sp">
              <div className="big" style={{ fontSize: 26 }}>{p.totalW !== null ? `${Math.round(p.totalW)} W` : "–"}</div>
              <span className="sub">{p.budgetW ? `of ${Math.round(p.budgetW)} W` : p.uptimeSec ? `up ${uptime(p.uptimeSec)}` : ""}</span>
            </div>
            {p.budgetW && p.totalW !== null && <Bar value={p.totalW / p.budgetW} tone={p.totalW / p.budgetW > 0.8 ? "warn" : undefined} />}
            {props.tile.h >= 3 && (
              <div className="outlets">
                {p.outlets.map((o: any) => (
                  <div key={o.index} className={`outlet ${o.on ? "on" : ""}`} title={o.voltageV ? `${o.voltageV} V · ${o.currentA ?? "–"} A` : undefined}>
                    <span className={`dot ${o.on === false ? "bad" : o.on ? "" : "mute"}`} style={{ position: "static" }} />
                    <span className="trunc">{o.name}</span>
                    <span className="sub">{o.metered && o.powerW !== null ? `${Math.round(o.powerW)} W` : o.on === false ? "off" : ""}</span>
                  </div>
                ))}
                {p.outlets.length === 0 && <span className="sub">UniFi does not share outlet or power data over the API key for this PDU.</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    )}</Shell>
  );
}
