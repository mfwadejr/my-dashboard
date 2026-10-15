import type { WidgetProps } from "./types";
import { Bar, Empty, Pill } from "./common";
import { Shell, uptime } from "./Shell";

/** AC outlets are rated 15 A at 120 V; amber at 60% of that, red at the 80% continuous-load limit. USB ports are far smaller. */
const AC_WARN_W = 1080, AC_HOT_W = 1440, USB_WARN_W = 15, USB_HOT_W = 25;

const isUsb = (o: any) => /usb/i.test(String(o.name));
function level(o: any): "off" | "on" | "warn" | "hot" {
  if (o.on !== true) return "off";
  const w = o.powerW ?? 0;
  const [warn, hot] = isUsb(o) ? [USB_WARN_W, USB_HOT_W] : [AC_WARN_W, AC_HOT_W];
  return w >= hot ? "hot" : w >= warn ? "warn" : "on";
}

function Socket({ usb }: { usb: boolean }) {
  return usb ? (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="2.5" y="8" width="19" height="8" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="6.5" y="11" width="11" height="2" rx="1" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="7.2" y="7.5" width="2" height="5" rx="1" fill="currentColor" />
      <rect x="14.8" y="7.5" width="2" height="5" rx="1" fill="currentColor" />
      <path d="M12 14.5v2.5M10.3 14.5h3.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}

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
            {props.tile.h >= 2 && (p.voltageV !== null || p.currentA !== null) && (
              <div className="sub">{[p.voltageV !== null && `${Math.round(p.voltageV)} V`, p.currentA !== null && `${p.currentA.toFixed(1)} A`,
                p.outlets.length > 0 && `${p.outlets.filter((o: any) => o.on).length}/${p.outlets.length} on`, p.uptimeSec && p.budgetW && `up ${uptime(p.uptimeSec)}`].filter(Boolean).join(" · ")}</div>
            )}
            {p.budgetW && p.totalW !== null && <Bar value={p.totalW / p.budgetW} tone={p.totalW / p.budgetW > 0.8 ? "warn" : undefined} />}
            {p.totalW === null && p.fields && <div className="sub" style={{ wordBreak: "break-word" }}>No watt reading found. UniFi sent: {p.fields}</div>}
            {props.tile.h >= 3 && (
              <div className="outlets">
                {p.outlets.map((o: any) => (
                  <div key={o.index} className={`outlet ${level(o)}`} title={o.voltageV ? `${o.voltageV} V · ${o.currentA ?? "–"} A` : undefined}>
                    <span className="sock"><Socket usb={isUsb(o)} /></span>
                    <span className="trunc">{o.name}</span>
                    <span className="sub">{o.powerW !== null ? `${o.powerW < 10 ? o.powerW.toFixed(1) : Math.round(o.powerW)} W` : o.on === false ? "off" : ""}</span>
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
