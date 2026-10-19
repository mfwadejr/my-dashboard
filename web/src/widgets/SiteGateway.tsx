import type { ReactNode } from "react";
import type { WidgetProps } from "./types";
import { Empty, Pill, Sparkline } from "./common";
import { useSeries } from "../hooks";
import { Shell } from "./Shell";
import { resolveSections } from "./sections";

const tone = (ok: boolean) => (ok ? "ok" : "bad");

export function SiteGateway(props: WidgetProps) {
  const id = props.tile.config.integrationId as string | undefined;
  const series = useSeries(id, "live_requests", 180);
  const tall = props.tile.h >= 4;
  return (
    <Shell props={props} label="Site Gateway">{d => {
      const attention = [...d.attention].sort((a: any, b: any) => Number(b.severity === "critical") - Number(a.severity === "critical"));
      const render: Record<string, () => ReactNode> = {
        status: () => (
          <div className="row wrap">
            <Pill tone={tone(d.gateway.healthy)}>Gateway</Pill>
            <Pill tone={tone(d.services.http)}>HTTP</Pill>
            {d.services.httpsConfigured && <Pill tone={tone(d.services.https)}>HTTPS</Pill>}
            <Pill tone={tone(d.services.storage)}>Storage</Pill>
          </div>
        ),
        counts: () => (
          <div className="stats3">
            <div><b className={d.hosted.errors ? "warn" : ""}>{d.hosted.running}/{d.hosted.total}</b><span>sites</span></div>
            <div><b className={d.proxies.errors ? "warn" : ""}>{d.proxies.running}/{d.proxies.total}</b><span>proxies</span></div>
            <div><b className={d.certificates.within30Days ? "warn" : ""}>{d.certificates.healthy}/{d.certificates.total}</b><span>certs ok</span></div>
          </div>
        ),
        attention: () => attention.length === 0 ? <div className="empty-note">Nothing needs attention</div> : tall || props.tile.h >= 3 ? (
          <div className="list">{attention.slice(0, tall ? 10 : 3).map((a: any, i: number) => (
            <div key={i} className="li col"><span className="row sp"><b className="trunc">{a.name}</b><Pill tone={a.severity === "critical" ? "bad" : "warn"}>{a.severity}</Pill></span><span className="sub">{a.message}</span></div>
          ))}{attention.length > (tall ? 10 : 3) && <div className="sub">and {attention.length - (tall ? 10 : 3)} more</div>}</div>
        ) : <div className="health-msg">⚠ {d.attentionCount} item{d.attentionCount === 1 ? "" : "s"} need attention</div>,
        traffic: () => (
          <div>
            <div className="row sp"><span className="sub">Requests per minute</span><b>{d.liveRequests}</b></div>
            <Sparkline points={series} height={tall ? 46 : 30} />
          </div>
        ),
        upstreams: () => (
          <div className="stats3">
            <div><b className={d.upstreams.unhealthy ? "warn" : ""}>{d.upstreams.healthy}/{d.upstreams.total}</b><span>upstreams up</span></div>
            <div><b>{d.streams.listening}/{d.streams.total}</b><span>stream ports</span></div>
            <div><b className={d.hosted.disabled || d.proxies.disabled ? "warn" : ""}>{d.hosted.disabled + d.proxies.disabled}</b><span>disabled</span></div>
          </div>
        ),
        certs: () => (
          <div className="row sp">
            <span className="sub">Expiring certificates</span>
            <span className="row g6">
              <Pill tone={d.certificates.within7Days ? "bad" : "mute"}>{d.certificates.within7Days} in 7 days</Pill>
              <Pill tone={d.certificates.within30Days ? "warn" : "mute"}>{d.certificates.within30Days} in 30 days</Pill>
            </span>
          </div>
        ),
        system: () => <div className="sub foot">{[d.version && `Version ${d.version}`, d.publicIp].filter(Boolean).join(" · ") || "No details"}</div>
      };
      const sections = resolveSections("sitegateway", props.tile.config.sections).filter(s => s.on);
      return sections.length === 0 ? <Empty>Turn on sections in this tile's settings.</Empty> : <>{sections.map(s => { const node = render[s.id]?.(); return node ? <div key={s.id} className="usec">{node}</div> : null; })}</>;
    }}</Shell>
  );
}
