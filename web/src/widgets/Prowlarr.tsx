import { useState, type ReactNode } from "react";
import { api } from "../api";
import type { WidgetProps } from "./types";
import { Empty, Pill } from "./common";
import { Shell } from "./Shell";
import { resolveSections } from "./sections";

const ago = (iso: string | null) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const until = (iso: string | null) => {
  if (!iso) return "";
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  return mins <= 0 ? "soon" : mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h`;
};

function TestAll({ id, authed }: { id: string; authed: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  if (!authed) return <div className="sub">Sign in to test indexers.</div>;
  const run = async () => {
    if (!window.confirm("Test every indexer now? Prowlarr contacts each one, which can take a minute.")) return;
    setBusy(true); setMsg(null);
    try { const r = await api.post<{ message?: string }>(`/api/integrations/${id}/actions/testall`); setMsg({ text: r.message ?? "Done", bad: false }); }
    catch (e) { setMsg({ text: e instanceof Error ? e.message : "The test failed", bad: true }); }
    setBusy(false);
  };
  return (
    <div className="row sp">
      <button type="button" className="btn sm" disabled={busy} onClick={() => void run()}>{busy ? "Testing…" : "Test all indexers"}</button>
      {msg && <span className={`sub${msg.bad ? " warn" : ""}`} role="status">{msg.text}</span>}
    </div>
  );
}

export function Prowlarr(props: WidgetProps) {
  const id = props.tile.config.integrationId as string | undefined;
  const tall = props.tile.h >= 4;
  return (
    <Shell props={props} label="Indexers">{d => {
      const render: Record<string, () => ReactNode> = {
        summary: () => (
          <>
            <div className="stats3">
              <div><b>{d.indexers.enabled}</b><span>enabled</span></div>
              <div><b className={d.indexers.failing ? "warn" : ""}>{d.indexers.failing}</b><span>blocked</span></div>
              <div><b>{d.totals.grabs}</b><span>grabs</span></div>
            </div>
            {d.health.issues > 0 && <div className="health-msg" title={d.health.messages.join("\n")}>⚠ {d.health.messages[0]}</div>}
          </>
        ),
        stats: () => (
          <div className="row sp" style={{ flexWrap: "wrap", gap: 6 }}>
            <span className="sub">{d.totals.successPct === null || d.totals.successPct === undefined ? "No searches yet" : `${d.totals.successPct}% of searches worked`}</span>
            <span className="row" style={{ gap: 6 }}>
              <Pill tone={d.totals.failed ? "warn" : "mute"}>{d.totals.failed} failed search{d.totals.failed === 1 ? "" : "es"}</Pill>
              <Pill tone={d.totals.failedGrabs ? "warn" : "mute"}>{d.totals.failedGrabs} failed grab{d.totals.failedGrabs === 1 ? "" : "s"}</Pill>
            </span>
          </div>
        ),
        blocked: () => d.failing.length === 0 ? <div className="sub">No indexers are blocked.</div> : (
          <div className="list">{d.failing.map((f: any) => <div key={f.name} className="li"><span className="trunc">{f.name}</span><Pill tone="bad">blocked · {until(f.blockedUntil)}</Pill></div>)}</div>
        ),
        top: () => d.top.length === 0 ? <Empty>No indexer activity yet</Empty> : (
          <div className="list">{d.top.slice(0, tall ? 6 : 3).map((i: any) => <div key={i.id} className="li"><span className="trunc">{i.name}</span><span className="sub">{i.queries} queries{i.avgMs ? ` · ${Math.round(i.avgMs)} ms` : ""}</span></div>)}</div>
        ),
        indexers: () => (
          <div className="list">{d.all.slice(0, tall ? 30 : 8).map((i: any) => (
            <div key={i.id} className="li col" title={i.lastFailure ? `Last failure ${ago(i.lastFailure)}` : undefined}>
              <div className="row sp"><span className="trunc">{i.name}</span><Pill tone={i.state === "ok" ? "ok" : i.state === "blocked" ? "bad" : "mute"}>{i.state === "blocked" ? `blocked · ${until(i.blockedUntil)}` : i.state}</Pill></div>
              <span className="sub trunc">{[i.protocol, i.priority !== null && `priority ${i.priority}`, i.queries ? `${i.queries} queries` : "", i.failPct ? `${i.failPct}% failed` : "", i.avgMs ? `${Math.round(i.avgMs)} ms` : ""].filter(Boolean).join(" · ")}</span>
            </div>
          ))}{d.all.length === 0 && <Empty>No indexers added</Empty>}</div>
        ),
        recent: () => d.recent.length === 0 ? <Empty>No recent searches</Empty> : (
          <div className="list">{d.recent.slice(0, tall ? 10 : 4).map((r: any, n: number) => (
            <div key={n} className="li col">
              <div className="row sp"><span className="trunc">{r.what || (r.kind === "grab" ? "Grab" : "Search")}</span><Pill tone={r.ok ? (r.kind === "grab" ? "ok" : "mute") : "bad"}>{r.ok ? r.kind : `${r.kind} failed`}</Pill></div>
              <span className="sub trunc">{[r.indexer, r.source, ago(r.date)].filter(Boolean).join(" · ")}</span>
            </div>
          ))}</div>
        ),
        test: () => id ? <TestAll id={id} authed={props.authed} /> : null
      };
      const sections = resolveSections("prowlarr", props.tile.config.sections).filter(s => s.on);
      return sections.length === 0 ? <Empty>Turn on sections in this tile's settings.</Empty> : <>{sections.map(s => { const node = render[s.id]?.(); return node ? <div key={s.id} className="usec">{node}</div> : null; })}</>;
    }}</Shell>
  );
}
