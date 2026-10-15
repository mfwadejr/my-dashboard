import type { WidgetProps } from "./types";
import { Bar, Empty, Live, Pill, Title, relDate } from "./common";

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

export function Arr(props: WidgetProps) {
  const { id, info, snap } = useSnapshot(props);
  const kind = props.tile.type === "sonarr" ? "TV" : "Movies";
  if (!id || !info) return <NeedsConnection label={kind} editing={props.editing} openSettings={props.openSettings} missing={Boolean(id)} />;
  if (!snap) return <><Title right={<Live ok={false} />}>{info.name}</Title><Empty>Loading…</Empty></>;
  const d = snap.data;
  if (!d) return <><Title right={<Live ok={false} />}>{info.name}</Title><Empty>{snap.error ?? "No data yet"}</Empty></>;
  const tall = props.tile.h >= 3;
  return (
    <>
      <Title right={<Live ok={snap.ok} stale />}>{info.name}</Title>
      {!snap.ok && <div className="stale-note" title={snap.error ?? ""}>Showing last known data · {snap.error}</div>}
      <div className="stats3">
        <div><b>{d.queue.count}</b><span>in queue</span></div>
        <div><b>{d.missing ?? "–"}</b><span>missing</span></div>
        <div><b className={d.health.issues ? "warn" : ""}>{d.health.issues}</b><span>health</span></div>
      </div>
      {d.health.issues > 0 && <div className="health-msg" title={d.health.messages.join("\n")}>⚠ {d.health.messages[0]}</div>}
      <div className="list">
        {d.queue.items.slice(0, tall ? 6 : 3).map((item: any) => (
          <div key={item.id} className="li col">
            <div className="row sp"><span className="trunc">{item.title}{item.subtitle ? <span className="sub"> · {item.subtitle}</span> : null}</span><span className="sub">{item.timeleft && item.timeleft !== "00:00:00" ? item.timeleft : ""}</span></div>
            <Bar value={item.progress} />
          </div>
        ))}
        {d.queue.items.length === 0 && <Empty>Queue is empty</Empty>}
      </div>
      {tall && d.upcoming.length > 0 && (
        <>
          <h4 className="sec">Coming up</h4>
          <div className="list">
            {d.upcoming.slice(0, 4).map((e: any, i: number) => (
              <div key={i} className="li"><span className="trunc">{e.title}{e.subtitle ? <span className="sub"> · {e.subtitle}</span> : null}</span><Pill tone={e.hasFile ? "ok" : "mute"}>{relDate(e.date)}</Pill></div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
