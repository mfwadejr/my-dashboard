import type { WidgetProps } from "./types";
import { Empty, Pill } from "./common";
import { Shell } from "./Shell";

export function Prowlarr(props: WidgetProps) {
  return (
    <Shell props={props} label="Indexers">{d => (
      <>
        <div className="stats3">
          <div><b>{d.indexers.enabled}</b><span>enabled</span></div>
          <div><b className={d.indexers.failing ? "warn" : ""}>{d.indexers.failing}</b><span>blocked</span></div>
          <div><b>{d.totals.grabs}</b><span>grabs</span></div>
        </div>
        {d.health.issues > 0 && <div className="health-msg" title={d.health.messages.join("\n")}>⚠ {d.health.messages[0]}</div>}
        {props.tile.h >= 3 && (
          <div className="list">
            {d.failing.map((f: any) => <div key={f.name} className="li"><span className="trunc">{f.name}</span><Pill tone="bad">blocked</Pill></div>)}
            {d.top.map((i: any) => <div key={i.id} className="li"><span className="trunc">{i.name}</span><span className="sub">{i.queries} queries{i.avgMs ? ` · ${Math.round(i.avgMs)} ms` : ""}</span></div>)}
            {d.top.length === 0 && d.failing.length === 0 && <Empty>No indexer activity yet</Empty>}
          </div>
        )}
      </>
    )}</Shell>
  );
}
