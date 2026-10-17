import type { WidgetProps } from "./types";
import type { ReactNode } from "react";
import { Bar, Empty, Live, Pill, Title, relDate, formatSize } from "./common";
import { resolveSections } from "./sections";

function useSnapshot({ tile, snapshots, integrations }: WidgetProps) {
  const id = tile.config.integrationId as string | undefined;
  const info = integrations.find(i => i.id === id);
  return { id, info, snap: id ? snapshots[id] : undefined };
}

export function NeedsConnection({ label, editing, openSettings, missing }: { label: string; editing: boolean; openSettings: () => void; missing: boolean }) {
  return (
    <>
      <Title>{label}</Title>
      <Empty>{missing ? "This tile's connection was removed." : "Choose which connection this tile shows."}</Empty>
      {editing && <button className="btn sm" onClick={openSettings}>Choose connection</button>}
    </>
  );
}

const sub = (e: any) => (e.subtitle ? <span className="sub"> · {e.subtitle}</span> : null);
const free = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`);

export function Arr(props: WidgetProps) {
  const { id, info, snap } = useSnapshot(props);
  const kind = props.tile.type === "sonarr" ? "TV" : "Movies";
  if (!id || !info) return <NeedsConnection label={kind} editing={props.editing} openSettings={props.openSettings} missing={Boolean(id)} />;
  if (!snap) return <><Title right={<Live ok={false} />}>{info.name}</Title><Empty>Loading…</Empty></>;
  const d = snap.data;
  if (!d) return <><Title right={<Live ok={false} />}>{info.name}</Title><Empty>{snap.error ?? "No data yet"}</Empty></>;
  const tall = props.tile.h >= 3;
  const noun = props.tile.type === "sonarr" ? "series" : "movies";
  const render: Record<string, () => ReactNode> = {
    summary: () => (
      <>
        <div className="stats3">
          <div><b className={d.troubleCount ? "warn" : ""}>{d.queue.count}</b><span>in queue</span></div>
          <div><b>{d.missing ?? "–"}</b><span>missing</span></div>
          <div><b className={d.health.issues ? "warn" : ""}>{d.health.issues}</b><span>health</span></div>
        </div>
        {d.health.issues > 0 && <div className="health-msg" title={d.health.messages.join("\n")}>⚠ {d.health.messages[0]}</div>}
      </>
    ),
    queue: () => (
      <div className="list">
        {d.queue.items.slice(0, tall ? 6 : 3).map((item: any) => (
          <div key={item.id} className="li col" title={item.messages?.join("\n") || undefined}>
            <div className="row sp">
              <span className="trunc">{item.title}{sub(item)}</span>
              {item.trouble ? <Pill tone="bad">problem</Pill> : <span className="sub">{item.timeleft && item.timeleft !== "00:00:00" ? item.timeleft : ""}</span>}
            </div>
            <Bar value={item.progress} tone={item.trouble ? "bad" : undefined} />
            {(item.quality || item.client || item.trouble) && (
              <span className="sub trunc">{item.trouble && item.messages?.[0] ? item.messages[0] : [item.quality, item.sizeMB ? formatSize(item.sizeMB) : "", item.client].filter(Boolean).join(" · ")}</span>
            )}
          </div>
        ))}
        {d.queue.items.length === 0 && <Empty>Queue is empty</Empty>}
      </div>
    ),
    upcoming: () => d.upcoming.length > 0 ? (
      <>
        <h4 className="sec">Coming up</h4>
        <div className="list">
          {d.upcoming.slice(0, tall ? 6 : 3).map((e: any, i: number) => (
            <div key={i} className="li"><span className="trunc">{e.title}{sub(e)}</span><Pill tone={e.hasFile ? "ok" : "mute"}>{relDate(e.date)}</Pill></div>
          ))}
        </div>
      </>
    ) : <Empty>Nothing due in the next two weeks</Empty>,
    recent: () => d.recent?.length > 0 ? (
      <>
        <h4 className="sec">Recently added</h4>
        <div className="list">
          {d.recent.slice(0, tall ? 6 : 3).map((e: any, i: number) => (
            <div key={i} className="li"><span className="trunc">{e.title}{sub(e)}</span><span className="sub">{[e.quality, relDate(e.date)].filter(Boolean).join(" · ")}</span></div>
          ))}
        </div>
      </>
    ) : null,
    library: () => d.libraryCount === null ? null : (
      <div className="row sp">
        <span className="sub">{d.libraryCount} {noun}{d.monitoredCount !== null && d.monitoredCount !== d.libraryCount ? ` · ${d.monitoredCount} monitored` : ""}</span>
        {d.cutoffUnmet ? <span className="sub">{d.cutoffUnmet} upgrades wanted</span> : null}
      </div>
    ),
    disk: () => d.disks?.length > 0 ? (
      <div className="list">{d.disks.map((x: any, i: number) => (
        <div key={i}><div className="row sp"><span className="sub trunc">{x.label}</span><span className="sub">{free(x.freeB)} free of {free(x.totalB)}</span></div><Bar value={1 - x.freeB / x.totalB} tone={x.freeB / x.totalB < 0.05 ? "bad" : x.freeB / x.totalB < 0.15 ? "warn" : undefined} /></div>
      ))}</div>
    ) : null
  };
  const sections = resolveSections(props.tile.type, props.tile.config.sections).filter(s => s.on);
  return (
    <>
      <Title right={<Live ok={snap.ok} stale />}>{String(props.tile.config.title || info.name)}</Title>
      {!snap.ok && <div className="stale-note" title={snap.error ?? ""}>Showing last known data · {snap.error}</div>}
      {sections.map(s => { const node = render[s.id]?.(); return node ? <div key={s.id} className="usec">{node}</div> : null; })}
      {sections.length === 0 && <Empty>Turn on sections in this tile's settings.</Empty>}
    </>
  );
}
