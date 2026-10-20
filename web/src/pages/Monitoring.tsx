import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { DayBars, ResponseChart, StateDot, STATE_LABEL, Strip, fmtMs, fmtPct, groupRows, groupState } from "../components/MonitorBits";
import { BLANK_MONITOR, MonitorForm, formFrom, type MonitorFormValues } from "../components/MonitorForm";
import { Modal } from "../dialogs/Modal";
import { useMonitors } from "../hooks";
import { fmtDateTime, useSettings } from "../settings";
import { ago, useNotice } from "../settings/ui";
import type { AuthUser, MonitorHistory, MonitorInfo } from "../types";
import { Confirm, Pill } from "../widgets/common";

const KIND_LABEL: Record<string, string> = { http: "Website", keyword: "Keyword", json: "JSON", tcp: "Port", ping: "Ping", dns: "DNS", cert: "Certificate", push: "Heartbeat" };
const RANGES = [["Last 6 hours", 6], ["Last 24 hours", 24], ["Last 7 days", 168], ["Last 30 days", 720], ["Last 90 days", 2160]] as const;

const where = (m: MonitorInfo) => {
  const c = m.config;
  if (!c) return "";
  return c.kind === "tcp" || c.kind === "cert" ? `${c.target}:${c.port}` : c.kind === "dns" ? `${c.dnsType} ${c.target}` : c.kind === "push" ? "waits for a call" : c.target.replace(/^https?:\/\//, "");
};

/** The Monitoring tab: every monitor, grouped, with a detail view for each. Everyone signed in can look; administrators can change things. */
export function Monitoring({ me, onSettings }: { me: AuthUser; onSettings: () => void }) {
  const admin = me.role === "admin";
  const { items, loaded, reload } = useMonitors();
  const n = useNotice();
  const [editing, setEditing] = useState<{ id?: string; form: MonitorFormValues } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const groups = useMemo(() => [...new Set(items.map(m => m.group).filter(Boolean))], [items]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? items.filter(m => `${m.name} ${m.group} ${m.description} ${m.config ? where(m) : ""}`.toLowerCase().includes(t)) : items;
  }, [items, q]);
  const sections = groupRows(shown);
  const counts = { up: items.filter(m => m.state === "up").length, down: items.filter(m => m.state === "down").length, pending: items.filter(m => m.state === "pending").length, maint: items.filter(m => m.state === "maintenance").length, paused: items.filter(m => m.state === "paused").length };
  const bulk = async (ids: string[], action: "pause" | "resume") => {
    n.clear();
    try { await api.post("/api/monitors/bulk", { ids, action }); await reload(); n.ok(action === "pause" ? "Paused." : "Resumed."); } catch (e) { n.bad(e); }
  };
  const detail = items.find(m => m.id === open);

  return (
    <div className="monpage">
      <div className="monhead">
        <div>
          <h2>Monitoring</h2>
          <p className="sub">{!loaded ? "Loading…" : !items.length ? "Nothing is being watched yet." : `${items.length} monitor${items.length === 1 ? "" : "s"} · checked on a schedule from this machine`}</p>
        </div>
        <div className="row g8 wrapme">
          {items.length > 0 && <>
            {counts.down > 0 ? <Pill tone="bad">{counts.down} down</Pill> : counts.pending > 0 ? <Pill tone="warn">{counts.pending} retrying</Pill> : counts.up > 0 ? <Pill tone="ok">all up</Pill> : <Pill tone="mute">waiting</Pill>}
            {counts.maint > 0 && <Pill tone="mute">{counts.maint} in maintenance</Pill>}
            {counts.paused > 0 && <Pill tone="mute">{counts.paused} paused</Pill>}
          </>}
          {admin && <button className="btn" onClick={onSettings}>Status pages & maintenance</button>}
          {admin && <button className="btn pri" onClick={() => setEditing({ form: { ...BLANK_MONITOR } })}>＋ Add a monitor</button>}
        </div>
      </div>
      {n.el}
      {items.length > 6 && <input className="monsearch" type="search" aria-label="Filter monitors" placeholder="Filter by name, group or address…" value={q} onChange={e => setQ(e.target.value)} />}
      {loaded && !items.length && <div className="monempty"><p>{admin ? "Add a website, a port, a ping, a certificate or a heartbeat and Homebase starts keeping watch." : "An administrator has not added any monitors yet."}</p></div>}
      {sections.map(sec => {
        const state = groupState(sec.rows), up = sec.rows.filter(m => m.state === "up").length;
        const allPaused = sec.rows.every(m => !m.enabled);
        return (
          <section key={sec.name || "_"} className="mgroup">
            {(sec.name || sections.length > 1) && (
              <div className="mghead">
                <span className="row g8 f1"><StateDot state={state} /><b>{sec.name || "Other"}</b><span className="sub">{up} of {sec.rows.length} up</span></span>
                {admin && <button className="btn sm" onClick={() => void bulk(sec.rows.map(m => m.id), allPaused ? "resume" : "pause")}>{allPaused ? "Resume group" : "Pause group"}</button>}
              </div>
            )}
            <div className="mglist">
              {sec.rows.map(m => (
                <button key={m.id} type="button" className="mitem" onClick={() => setOpen(m.id)} aria-label={`${m.name}: ${STATE_LABEL[m.state]}. Show details`}>
                  <StateDot state={m.state} />
                  <span className="mname"><b className="trunc">{m.name}</b><span className="sub trunc">{m.description || where(m) || KIND_LABEL[m.kind]}</span></span>
                  <span className="mkind sub">{KIND_LABEL[m.kind]}</span>
                  <Strip checks={m.strip} count={30} />
                  <span className="mnum"><b>{m.state === "down" ? "Down" : m.state === "maintenance" ? "Maint." : fmtMs(m.lastMs)}</b></span>
                  <span className="mnum sub">{fmtPct(m.uptime24h)}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {loaded && items.length > 0 && !shown.length && <p className="sub">Nothing matches that filter.</p>}
      {detail && <Detail m={detail} admin={admin} onClose={() => setOpen(null)} reload={reload}
        onEdit={() => { if (detail.config) { setOpen(null); setEditing({ id: detail.id, form: formFrom(detail.config) }); } }}
        onClone={() => { if (detail.config) { setOpen(null); setEditing({ form: { ...formFrom(detail.config), name: `${detail.name} (copy)` } }); } }} />}
      {editing && <MonitorForm id={editing.id} start={editing.form} groups={groups} pushBase={window.location.origin} onClose={() => setEditing(null)} onSaved={async text => { setEditing(null); await reload(); n.ok(text); }} />}
    </div>
  );
}

function Detail({ m, admin, onClose, onEdit, onClone, reload }: { m: MonitorInfo; admin: boolean; onClose: () => void; onEdit: () => void; onClone: () => void; reload: () => Promise<void> }) {
  const { settings } = useSettings();
  const [hours, setHours] = useState(24);
  const [h, setH] = useState<MonitorHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const n = useNotice();
  useEffect(() => {
    let live = true;
    const load = () => { void api.get<MonitorHistory>(`/api/monitors/${m.id}/history?hours=${hours}`).then(r => { if (live) setH(r); }).catch(() => {}); };
    load();
    const t = window.setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => { live = false; window.clearInterval(t); };
  }, [m.id, hours, m.lastAt]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => { n.clear(); setBusy(true); try { await fn(); await reload(); if (ok) n.ok(ok); } catch (e) { n.bad(e); } setBusy(false); };
  const u = h?.uptimes;
  const pushUrl = m.config?.kind === "push" ? `${window.location.origin}/api/push/${m.config.target}?status=up&msg=OK` : "";

  return (
    <Modal title={m.name} eyebrow={m.group ? `Monitoring · ${m.group}` : "Monitoring"} onClose={onClose} wide>
      <div className="form">
        <div className="row g8 wrapme">
          <StateDot state={m.state} /><b>{STATE_LABEL[m.state]}</b>
          {m.since && m.state !== "unknown" && m.state !== "paused" && <span className="sub">for {ago(m.since).replace(" ago", "")}</span>}
          {m.config && <span className="sub trunc">{where(m)}</span>}
        </div>
        {m.description && <p className="sub">{m.description}</p>}
        {(m.state === "down" || m.state === "pending") && <p className="error sm">{m.message}</p>}
        {pushUrl && <p className="sub">Your script calls <code className="brk">{pushUrl}</code> (add <code>status=down</code> to report a failure).</p>}
        <div className="mstats">
          <div><span className="sub">Response</span><b>{fmtMs(m.lastMs)}</b></div>
          <div><span className="sub">Average (24 h)</span><b>{fmtMs(m.avgMs24h)}</b></div>
          <div><span className="sub">Uptime 24 h</span><b>{fmtPct(u?.d1 ?? m.uptime24h)}</b></div>
          <div><span className="sub">Uptime 7 d</span><b>{fmtPct(u?.d7 ?? m.uptime7d)}</b></div>
          <div><span className="sub">Uptime 30 d</span><b>{fmtPct(u?.d30 ?? m.uptime30d)}</b></div>
          <div><span className="sub">Uptime 90 d</span><b>{fmtPct(u?.d90)}</b></div>
          <div><span className="sub">Uptime 1 year</span><b>{fmtPct(u?.d365)}</b></div>
          {m.certExpires && <div><span className="sub">Certificate ends</span><b>{fmtDateTime(m.certExpires, settings)}</b></div>}
        </div>
        <div className="row sp wrapme"><b>Response time</b>
          <select aria-label="Time range" value={hours} onChange={e => setHours(Number(e.target.value))}>{RANGES.map(([l, v]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
        {h ? <ResponseChart points={h.points} hours={hours} /> : <p className="sub">Loading…</p>}
        {h && h.days.length > 0 && <>
          <b>Last {h.days.length} days</b>
          <DayBars days={h.days} />
        </>}
        {h && h.events.length > 0 && <>
          <b>Changes</b>
          <div className="list">{h.events.slice(0, 8).map(e => (
            <div key={e.ts} className="li"><span className="row g8 f1"><StateDot state={e.up ? "up" : "down"} /><span className="trunc">{e.msg}</span></span><span className="sub">{fmtDateTime(e.ts, settings)}</span></div>
          ))}</div>
        </>}
        {h && h.recent.length > 0 && <>
          <b>Latest checks</b>
          <div className="list">{h.recent.slice(0, 8).map(r => (
            <div key={r.ts} className="li"><span className="row g8 f1"><StateDot state={r.s === 1 ? "up" : r.s === 0 ? "down" : r.s === 3 ? "maintenance" : "pending"} /><span className="trunc">{r.msg || "OK"}</span></span><span className="sub">{r.ms !== null ? `${r.ms} ms · ` : ""}{ago(r.ts)}</span></div>
          ))}</div>
        </>}
        {n.el}
        {admin && (
          <div className="acts">
            <span className="row g8 wrapme">
              <button className="btn" disabled={busy || m.kind === "push"} onClick={() => void run(async () => { const r = await api.post<{ up: boolean; message: string }>(`/api/monitors/${m.id}/check`); n.setNote({ ok: r.up, text: `Checked: ${r.message}` }); })}>Check now</button>
              <button className="btn" onClick={onEdit}>Edit</button>
              <button className="btn" onClick={onClone}>Clone</button>
              <button className="btn" disabled={busy} onClick={() => void run(() => api.put(`/api/monitors/${m.id}`, { enabled: !m.enabled }), m.enabled ? "Paused." : "Resumed.")}>{m.enabled ? "Pause" : "Resume"}</button>
            </span>
            <Confirm label="Remove…" name={`Remove ${m.name}`} sure="Click again to remove it and its history" onGo={() => void run(async () => { await api.del(`/api/monitors/${m.id}`); onClose(); })} />
          </div>
        )}
      </div>
    </Modal>
  );
}
