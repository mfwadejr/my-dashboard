import type { WidgetProps } from "./types";
import { Pill } from "./common";
import { Shell } from "./Shell";

const tone = (ok: boolean) => (ok ? "ok" : "bad");

export function SiteGateway(props: WidgetProps) {
  return (
    <Shell props={props} label="Site Gateway">{d => (
      <>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <Pill tone={tone(d.gateway.healthy)}>Gateway</Pill>
          <Pill tone={tone(d.services.http)}>HTTP</Pill>
          {d.services.httpsConfigured && <Pill tone={tone(d.services.https)}>HTTPS</Pill>}
          <Pill tone={tone(d.services.storage)}>Storage</Pill>
        </div>
        <div className="stats3">
          <div><b>{d.hosted.running}/{d.hosted.total}</b><span>sites</span></div>
          <div><b className={d.proxies.errors ? "warn" : ""}>{d.proxies.running}/{d.proxies.total}</b><span>proxies</span></div>
          <div><b className={d.certificates.within30Days ? "warn" : ""}>{d.certificates.healthy}/{d.certificates.total}</b><span>certs ok</span></div>
        </div>
        {props.tile.h >= 3 && (
          <div className="list">
            {d.attention.map((a: any, i: number) => <div key={i} className="li col"><span className="row sp"><b className="trunc">{a.name}</b><Pill tone={a.severity === "critical" ? "bad" : "warn"}>{a.severity}</Pill></span><span className="sub">{a.message}</span></div>)}
            {d.attentionCount === 0 && <div className="empty-note">Nothing needs attention</div>}
          </div>
        )}
        {props.tile.h < 3 && d.attentionCount > 0 && <div className="health-msg">⚠ {d.attentionCount} item{d.attentionCount === 1 ? "" : "s"} need attention</div>}
        <div className="sub foot">{d.liveRequests} requests/min{d.upstreams.unhealthy ? ` · ${d.upstreams.unhealthy} upstream down` : ""}{d.publicIp ? ` · ${d.publicIp}` : ""}</div>
      </>
    )}</Shell>
  );
}
