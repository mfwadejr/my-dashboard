import { useState } from "react";
import { api } from "../api";
import { useSeries } from "../hooks";
import type { WidgetProps } from "./types";
import { Bar, Empty, Live, Pill, Sparkline, Title, formatSize, formatSpeed } from "./common";
import { NeedsConnection } from "./Arr";

export function Sab(props: WidgetProps) {
  const id = props.tile.config.integrationId as string | undefined;
  const info = props.integrations.find(i => i.id === id);
  const snap = id ? props.snapshots[id] : undefined;
  const series = useSeries(id, "speed_kbs", 180);
  const [busy, setBusy] = useState(false);
  if (!id || !info) return <NeedsConnection label="Downloads" editing={props.editing} openSettings={props.openSettings} missing={Boolean(id)} />;
  if (!snap) return <><Title right={<Live ok={false} />}>{info.name}</Title><Empty>Loading…</Empty></>;
  const d = snap.data;
  if (!d) return <><Title right={<Live ok={false} />}>{info.name}</Title><Empty>{snap.error ?? "No data yet"}</Empty></>;
  const toggle = async () => {
    setBusy(true);
    try { await api.post(`/api/integrations/${id}/actions/${d.paused ? "resume" : "pause"}`); } catch { /* the tile shows the real state on the next update */ }
    setBusy(false);
  };
  return (
    <>
      <Title right={<Live ok={snap.ok} stale />}>{info.name}</Title>
      {!snap.ok && <div className="stale-note" title={snap.error ?? ""}>Showing last known data · {snap.error}</div>}
      <div className="row sp">
        <div><div className="big">{d.paused ? "Paused" : formatSpeed(d.speedKBs)}</div><div className="sub">{d.queue.count} in queue · {formatSize(d.queue.sizeLeftMB)} left{d.queue.timeleft && !d.paused ? ` · ${d.queue.timeleft}` : ""}</div></div>
        {props.authed && <button className="btn sm" disabled={busy} onClick={toggle}>{d.paused ? "▶ Resume" : "⏸ Pause"}</button>}
      </div>
      {props.tile.h >= 2 && <Sparkline points={series} height={props.tile.h >= 3 ? 46 : 30} />}
      <div className="list">
        {d.queue.items.slice(0, props.tile.h >= 3 ? 5 : 2).map((item: any) => (
          <div key={item.id} className="li col">
            <div className="row sp"><span className="trunc">{item.name}</span><span className="sub">{Math.round(item.progress * 100)}%</span></div>
            <Bar value={item.progress} />
          </div>
        ))}
        {d.queue.items.length === 0 && <Empty>Nothing downloading</Empty>}
      </div>
      {props.tile.h >= 4 && d.history.length > 0 && (
        <>
          <h4 className="sec">Recent</h4>
          <div className="list">{d.history.slice(0, 3).map((h: any, i: number) => <div key={i} className="li"><span className="trunc">{h.name}</span><Pill tone={h.status === "Completed" ? "ok" : "bad"}>{h.status}</Pill></div>)}</div>
        </>
      )}
      {d.diskFreeGB !== null && <div className="sub foot">{Math.round(d.diskFreeGB)} GB free</div>}
    </>
  );
}
