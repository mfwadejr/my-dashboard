import { useState, type ReactNode } from "react";
import { api } from "../api";
import { useSeries } from "../hooks";
import type { WidgetProps } from "./types";
import { Bar, Confirm, Empty, Pill, Sparkline } from "./common";
import { Gauge } from "./Gauge";
import { Shell, bytes } from "./Shell";
import { resolveSections } from "./sections";

const arrayTone = (s: string) => (s === "STARTED" ? "ok" : s ? "warn" : "mute");
type Act = (name: string, body: Record<string, unknown>) => Promise<void>;
const hours = (sec: number | null) => (sec === null ? "" : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`);
const day = (iso: string | null) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : ""; };

function Containers({ d, tall, authed, act, busy }: { d: any; tall: boolean; authed: boolean; act: Act; busy: boolean }) {
  if (!d.docker) return <Empty>This key cannot read Docker.</Empty>;
  const rows = d.docker.list.slice(0, tall ? 20 : 6);
  if (rows.length === 0) return <Empty>No containers</Empty>;
  return (
    <div className="list">{rows.map((c: any) => (
      <div key={c.id} className="li" title={[c.status, c.image].filter(Boolean).join(" · ") || undefined}>
        <span className="trunc">{c.name}</span>
        <span className="row" style={{ gap: 4, flex: "none" }}>
          {c.update && <Pill tone="warn">update</Pill>}
          <Pill tone={c.running ? "ok" : "mute"}>{c.running ? "running" : c.state || "stopped"}</Pill>
          {authed && (c.running ? (
            <>
              <Confirm label="↻" name={`Restart ${c.name}`} sure="Restart?" disabled={busy} onGo={() => void act("containerrestart", { id: c.id })} />
              <Confirm label="■" name={`Stop ${c.name}`} sure="Stop?" disabled={busy} onGo={() => void act("containerstop", { id: c.id })} />
            </>
          ) : <button type="button" className="btn sm" disabled={busy} aria-label={`Start ${c.name}`} onClick={() => void act("containerstart", { id: c.id })}>▶</button>)}
        </span>
      </div>
    ))}{d.docker.list.length > rows.length && <div className="sub">and {d.docker.list.length - rows.length} more</div>}</div>
  );
}

function Vms({ d, tall, authed, act, busy }: { d: any; tall: boolean; authed: boolean; act: Act; busy: boolean }) {
  if (!d.vms) return <Empty>This key cannot read VMs.</Empty>;
  const rows = d.vms.list.slice(0, tall ? 12 : 5);
  if (rows.length === 0) return <Empty>No virtual machines</Empty>;
  return (
    <div className="list">{rows.map((v: any) => (
      <div key={v.id} className="li">
        <span className="trunc">{v.name}</span>
        <span className="row" style={{ gap: 4 }}>
          <Pill tone={v.running ? "ok" : "mute"}>{v.state || "unknown"}</Pill>
          {authed && (v.running ? (
            <>
              <Confirm label="↻" name={`Reboot ${v.name}`} sure="Reboot?" disabled={busy} onGo={() => void act("vmreboot", { id: v.id })} />
              <Confirm label="■" name={`Shut down ${v.name}`} sure="Shut down?" disabled={busy} onGo={() => void act("vmstop", { id: v.id })} />
            </>
          ) : <button type="button" className="btn sm" disabled={busy} aria-label={`Start ${v.name}`} onClick={() => void act("vmstart", { id: v.id })}>▶</button>)}
        </span>
      </div>
    ))}</div>
  );
}

export function Unraid(props: WidgetProps) {
  const id = props.tile.config.integrationId as string | undefined;
  const cpuSeries = useSeries(id, "cpu_pct", 180), memSeries = useSeries(id, "mem_pct", 180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tall = props.tile.h >= 4;
  const act: Act = async (name, body) => {
    setBusy(true); setError(null);
    try { await api.post(`/api/integrations/${id}/actions/${name}`, body); } catch (e) { setError(e instanceof Error ? e.message : "That did not work"); }
    setBusy(false);
  };
  return (
    <Shell props={props} label="Unraid">{d => {
      const render: Record<string, () => ReactNode> = {
        summary: () => (
          <div className="row sp">
            <span className="sub">{d.host?.name ?? ""}</span>
            <span className="row">
              {d.array && <Pill tone={arrayTone(d.array.state)}>array {d.array.state.toLowerCase()}</Pill>}
              {d.array?.check?.running && <Pill tone="warn">parity {Math.round(d.array.check.progress ?? 0)}%</Pill>}
            </span>
          </div>
        ),
        array: () => d.array?.usedPct != null ? (
          <div><div className="row sp"><span className="sub">Array {d.array.usedPct}%</span><span className="sub">{bytes((d.array.usedKB ?? 0) * 1000)} of {bytes((d.array.totalKB ?? 0) * 1000)}</span></div><Bar value={d.array.usedPct / 100} tone={d.array.usedPct > 95 ? "bad" : d.array.usedPct > 85 ? "warn" : undefined} /></div>
        ) : null,
        gauges: () => (d.cpuPct != null || d.mem) ? (
          <div className="gauges">
            <Gauge pct={d.cpuPct} label="CPU" />
            <Gauge pct={d.mem?.pct} label="RAM" warn={80} detail={d.mem?.usedB != null ? `${bytes(d.mem.usedB)}${d.mem.totalB ? ` of ${bytes(d.mem.totalB)}` : ""}` : undefined} />
            {d.array?.hottest ? <div className={`sub${d.array.hottest > 50 ? " warn" : ""}`} style={{ gridColumn: "1 / -1", textAlign: "center" }}>Hottest disk {d.array.hottest}°C</div> : null}
          </div>
        ) : null,
        graph: () => (
          <div className="col" style={{ gap: 6 }}>
            <div><div className="sub">CPU, last few hours</div><Sparkline points={cpuSeries} height={tall ? 40 : 28} /></div>
            <div><div className="sub">RAM, last few hours</div><Sparkline points={memSeries} height={tall ? 40 : 28} /></div>
          </div>
        ),
        status: () => (
          <div className="row" style={{ flexWrap: "wrap" }}>
            {d.docker && <Pill tone={d.docker.running === d.docker.total ? "ok" : "warn"}>{d.docker.running}/{d.docker.total} containers</Pill>}
            {d.docker?.updates > 0 && <Pill tone="warn">{d.docker.updates} update{d.docker.updates === 1 ? "" : "s"}</Pill>}
            {d.vms && <Pill>{d.vms.running}/{d.vms.total} VMs</Pill>}
            {d.notifications?.alert > 0 && <Pill tone="bad">{d.notifications.alert} alert{d.notifications.alert === 1 ? "" : "s"}</Pill>}
            {d.notifications?.warning > 0 && <Pill tone="warn">{d.notifications.warning} warning{d.notifications.warning === 1 ? "" : "s"}</Pill>}
            {d.array?.diskProblems > 0 && <Pill tone="bad">{d.array.diskProblems} disk problem{d.array.diskProblems === 1 ? "" : "s"}</Pill>}
          </div>
        ),
        disks: () => d.array?.disks.length > 0 ? (
          <div className="list">{d.array.disks.slice(0, tall ? 30 : 6).map((x: any) => (
            <div key={`${x.kind}-${x.name}`} className="li">
              <span className="trunc">{x.name}{x.kind !== "data" && x.kind !== x.name ? <span className="sub"> · {x.kind}</span> : null}</span>
              <span className="row"><span className="sub">{x.usedPct != null ? `${x.usedPct}%` : ""}</span><span className={x.tempC > 50 ? "pill warn" : "sub"}>{x.tempC != null ? `${x.tempC}°C` : x.spinning === false ? "standby" : ""}</span></span>
            </div>
          ))}</div>
        ) : null,
        parity: () => {
          const c = d.array?.check, last = d.array?.lastCheck;
          if (!c && !last) return <div className="sub">No parity check information available.</div>;
          return (
            <div className="col" style={{ gap: 4 }}>
              {c?.running && <div><div className="row sp"><span className="sub">Parity check {c.paused ? "paused" : "running"}</span><span className="sub">{Math.round(c.progress ?? 0)}%</span></div><Bar value={(c.progress ?? 0) / 100} tone={c.errors ? "warn" : undefined} /></div>}
              {last && (
                <div className="row sp">
                  <span className="sub">Last check {day(last.date)}</span>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="sub">{[hours(last.durationSec), last.speed].filter(Boolean).join(" · ")}</span>
                    <Pill tone={last.errors ? "warn" : /ok|complete/i.test(last.status) ? "ok" : "mute"}>{last.errors ? `${last.errors} errors` : last.status.toLowerCase() || "done"}</Pill>
                  </span>
                </div>
              )}
            </div>
          );
        },
        shares: () => d.shares && d.shares.length > 0 ? (
          <div className="list">{d.shares.slice(0, tall ? 15 : 5).map((x: any) => (
            <div key={x.name} className="li col">
              <div className="row sp"><span className="trunc">{x.name}</span><span className="sub">{bytes((x.usedKB ?? 0) * 1000)}{x.usedPct != null ? ` · ${x.usedPct}% of ${bytes((x.totalKB ?? 0) * 1000)}` : ""}</span></div>
              {x.usedPct != null && <Bar value={x.usedPct / 100} tone={x.usedPct > 95 ? "bad" : x.usedPct > 85 ? "warn" : undefined} />}
            </div>
          ))}</div>
        ) : <div className="sub">This key cannot read shares.</div>,
        containers: () => <Containers d={d} tall={tall} authed={props.authed} act={act} busy={busy} />,
        vms: () => <Vms d={d} tall={tall} authed={props.authed} act={act} busy={busy} />
      };
      const sections = resolveSections("unraid", props.tile.config.sections).filter(s => s.on);
      return (
        <>
          {error && <div className="stale-note" role="alert">{error}</div>}
          {sections.length === 0 ? <Empty>Turn on sections in this tile's settings.</Empty> : sections.map(s => { const node = render[s.id]?.(); return node ? <div key={s.id} className="usec">{node}</div> : null; })}
          {!d.array && !d.docker && sections.length > 0 && <Empty>This key could not read the array or Docker.</Empty>}
        </>
      );
    }}</Shell>
  );
}
