import { useState, type ReactNode } from "react";
import { api } from "../api";
import { useSeries } from "../hooks";
import type { WidgetProps } from "./types";
import { Bar, Empty, Live, Pill, Sparkline, Title, formatSize, formatSpeed } from "./common";
import { NeedsConnection } from "./Arr";
import { resolveSections } from "./sections";

type Act = (name: string, body?: Record<string, unknown>) => Promise<void>;

/** A small button that asks twice before doing something that cannot be undone. */
function Confirm({ label, sure, onGo, disabled }: { label: string; sure: string; onGo: () => void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  return (
    <button type="button" className="btn sm" disabled={disabled} aria-label={label}
      onClick={() => { if (armed) { setArmed(false); onGo(); } else { setArmed(true); window.setTimeout(() => setArmed(false), 3000); } }}>
      {armed ? sure : "✕"}
    </button>
  );
}

const statusTone = (d: any) => (d.paused ? "warn" : /download|fetch|grab/i.test(d.status) ? "ok" : "mute");

function Summary({ d, authed, act, busy }: { d: any; authed: boolean; act: Act; busy: boolean }) {
  return (
    <>
      <div className="row sp">
        <div>
          <div className="big">{d.paused ? "Paused" : formatSpeed(d.speedKBs)}</div>
          <div className="sub">{d.queue.count} in queue · {formatSize(d.queue.sizeLeftMB)} left{d.queue.timeleft && !d.paused ? ` · ${d.queue.timeleft}` : ""}</div>
        </div>
        {authed && <button className="btn sm" disabled={busy} onClick={() => void act(d.paused ? "resume" : "pause")}>{d.paused ? "▶ Resume" : "⏸ Pause"}</button>}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {d.status && <Pill tone={statusTone(d)}>{d.status.toLowerCase()}</Pill>}
        {d.warnings > 0 && <Pill tone="warn">{d.warnings} warning{d.warnings === 1 ? "" : "s"}</Pill>}
      </div>
    </>
  );
}

function Queue({ d, tall, authed, act, busy }: { d: any; tall: boolean; authed: boolean; act: Act; busy: boolean }) {
  if (d.queue.items.length === 0) return <Empty>Nothing downloading</Empty>;
  return (
    <div className="list">
      {d.queue.items.slice(0, tall ? 6 : 3).map((item: any) => {
        const paused = /paus/i.test(item.status);
        return (
          <div key={item.id} className="li col">
            <div className="row sp"><span className="trunc">{item.name}</span><span className="sub">{Math.round(item.progress * 100)}%</span></div>
            <Bar value={item.progress} />
            <div className="row sp">
              <span className="sub trunc">{[item.category, formatSize(item.sizeMB), paused ? "paused" : item.timeleft].filter(Boolean).join(" · ")}</span>
              {authed && (
                <span className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn sm" disabled={busy} aria-label={paused ? "Resume job" : "Pause job"} onClick={() => void act(paused ? "resumejob" : "pausejob", { id: item.id })}>{paused ? "▶" : "⏸"}</button>
                  <Confirm label="Remove job" sure="Remove?" disabled={busy} onGo={() => void act("deletejob", { id: item.id })} />
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Disk({ d }: { d: any }) {
  if (d.diskFreeGB === null) return null;
  const total = d.diskTotalGB, free = d.diskFreeGB;
  const usedFrac = total ? Math.max(0, Math.min(1, (total - free) / total)) : null;
  return (
    <div>
      <div className="row sp"><span className="sub">Download disk</span><span className="sub">{Math.round(free)} GB free{total ? ` of ${Math.round(total)} GB` : ""}</span></div>
      {usedFrac !== null && <Bar value={usedFrac} tone={usedFrac > 0.95 ? "bad" : usedFrac > 0.85 ? "warn" : undefined} />}
    </div>
  );
}

function Limit({ d, authed, act, busy }: { d: any; authed: boolean; act: Act; busy: boolean }) {
  const now = d.speedLimitPct;
  const label = now === null ? "unknown" : now >= 100 || now === 0 ? "no limit" : `${now}%`;
  return (
    <div className="row sp">
      <span className="sub">Speed limit</span>
      {authed ? (
        <select value={now === null || now >= 100 ? "0" : String(now)} disabled={busy} onChange={e => void act("speedlimit", { percent: Number(e.target.value) })} aria-label="Speed limit">
          <option value="0">No limit</option>
          {[75, 50, 25, 10].map(p => <option key={p} value={p}>{p}%</option>)}
          {now !== null && now > 0 && now < 100 && ![75, 50, 25, 10].includes(now) && <option value={now}>{now}%</option>}
        </select>
      ) : <span className="sub">{label}</span>}
    </div>
  );
}

function History({ d, tall, authed, act, busy }: { d: any; tall: boolean; authed: boolean; act: Act; busy: boolean }) {
  const rows = d.history.slice(0, tall ? 8 : 3);
  return (
    <>
      {d.totals && (d.totals.day || d.totals.week) && <div className="sub">Downloaded: {[d.totals.day && `${d.totals.day} today`, d.totals.week && `${d.totals.week} this week`].filter(Boolean).join(" · ")}</div>}
      {rows.length === 0 ? <Empty>No recent history</Empty> : (
        <div className="list">{rows.map((h: any, i: number) => {
          const failed = /fail/i.test(h.status), ok = /complete/i.test(h.status);
          return (
            <div key={h.id || i} className="li col" title={h.failMessage ?? undefined}>
              <div className="row sp">
                <span className="trunc">{h.name}</span>
                <span className="row" style={{ gap: 4 }}>
                  {failed && authed && h.id && <button type="button" className="btn sm" disabled={busy} onClick={() => void act("retry", { id: h.id })}>Retry</button>}
                  <Pill tone={ok ? "ok" : failed ? "bad" : "mute"}>{h.status.toLowerCase()}</Pill>
                </span>
              </div>
              <span className="sub trunc">{[h.category, h.sizeBytes >= 1048576 ? formatSize(h.sizeBytes / 1048576) : "", failed && h.failMessage].filter(Boolean).join(" · ")}</span>
            </div>
          );
        })}</div>
      )}
    </>
  );
}

export function Sab(props: WidgetProps) {
  const id = props.tile.config.integrationId as string | undefined;
  const info = props.integrations.find(i => i.id === id);
  const snap = id ? props.snapshots[id] : undefined;
  const series = useSeries(id, "speed_kbs", 180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!id || !info) return <NeedsConnection label="Downloads" editing={props.editing} openSettings={props.openSettings} missing={Boolean(id)} />;
  if (!snap) return <><Title right={<Live ok={false} />}>{info.name}</Title><Empty>Loading…</Empty></>;
  const d = snap.data;
  if (!d) return <><Title right={<Live ok={false} />}>{info.name}</Title><Empty>{snap.error ?? "No data yet"}</Empty></>;
  const act: Act = async (name, body) => {
    setBusy(true); setError(null);
    try { await api.post(`/api/integrations/${id}/actions/${name}`, body); } catch (e) { setError(e instanceof Error ? e.message : "That did not work"); }
    setBusy(false);
  };
  const tall = props.tile.h >= 3;
  const sections = resolveSections("sabnzbd", props.tile.config.sections).filter(s => s.on);
  const render: Record<string, () => ReactNode> = {
    summary: () => <Summary d={d} authed={props.authed} act={act} busy={busy} />,
    graph: () => <Sparkline points={series} height={tall ? 46 : 30} />,
    queue: () => <Queue d={d} tall={tall} authed={props.authed} act={act} busy={busy} />,
    disk: () => <Disk d={d} />,
    limit: () => <Limit d={d} authed={props.authed} act={act} busy={busy} />,
    history: () => <History d={d} tall={props.tile.h >= 5} authed={props.authed} act={act} busy={busy} />
  };
  return (
    <>
      <Title right={<Live ok={snap.ok} stale />}>{String(props.tile.config.title || info.name)}</Title>
      {!snap.ok && <div className="stale-note" title={snap.error ?? ""}>Showing last known data · {snap.error}</div>}
      {error && <div className="stale-note" role="alert">{error}</div>}
      {sections.map(s => { const node = render[s.id]?.(); return node ? <div key={s.id} className="usec">{node}</div> : null; })}
      {sections.length === 0 && <Empty>Turn on sections in this tile's settings.</Empty>}
    </>
  );
}
