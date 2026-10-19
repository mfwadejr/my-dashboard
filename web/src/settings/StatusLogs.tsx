import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Pill } from "../widgets/common";
import { fmtDateTime, useSettings } from "../settings";
import { DiskNote } from "./Maintenance";
import { Section, ago } from "./ui";

interface Conn { id: string; name: string; type: string; typeName: string; enabled: boolean; ok: boolean | null; lastOk: number | null; checkedAt: number | null; error: string | null; ms: number | null; uptime24h: number | null; strip: Array<number | null> }
interface Status { disk?: { total: number; free: number; freePct: number; level: "ok" | "low" | "critical" } | null; maintenance?: { ts: number; ok: boolean; message: string } | null; update?: { aheadBy: number; upToDate: boolean; error: string | null; commits: Array<{ sha: string; message: string }> } | null; version: { version: string; commit: string; build: string }; uptimeS: number; connections: Conn[]; cameras: number; relay: { enabled: boolean; reachable: boolean }; publicPort: number | null; clients: number }
interface Line { id: number; ts: number; level: "info" | "warn" | "error"; source: string; message: string }

const dur = (s: number) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);
const TONE = { info: "mute", warn: "warn", error: "bad" } as const;

function StatusPanel({ openConnections }: { openConnections: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const load = useCallback(() => { void api.get<Status>("/api/status").then(setSt).catch(() => {}); }, []);
  useEffect(() => { load(); const t = window.setInterval(load, 10_000); return () => window.clearInterval(t); }, [load]);
  if (!st) return <p className="sub">Loading…</p>;
  return (
    <>
      <DiskNote disk={st.disk} />
      {st.maintenance && !st.maintenance.ok && <p className="error" role="alert">The last database upkeep found a problem: {st.maintenance.message} Save a backup copy and look at the log.</p>}
      {st.update && !st.update.error && !st.update.upToDate && <p className="ok-note">An update is available: {st.update.aheadBy} newer change(s) on GitHub{st.update.commits[0] ? `, newest “${st.update.commits[0].message}”` : ""}. Pull the new image to get it.</p>}
      <div className="statline">
        <span>Homebase <b>{st.version.version}</b> ({st.version.commit})</span><span>Running for <b>{dur(st.uptimeS)}</b></span>
        <span>Camera relay: <Pill tone={!st.relay.enabled ? "mute" : st.relay.reachable ? "ok" : "bad"}>{!st.relay.enabled ? "not set up" : st.relay.reachable ? "reachable" : "unreachable"}</Pill></span>
        <span>{st.cameras} camera(s)</span><span>{st.clients} screen(s) connected live</span>
        <span>Sharing port: {st.publicPort ? <Pill tone="ok">{st.publicPort}</Pill> : <Pill tone="mute">off</Pill>}</span>
      </div>
      <div className="rows">
        {st.connections.length === 0 && <p className="sub">No connections yet.</p>}
        {st.connections.map(c => (
          <div key={c.id} className="srow col">
            <div className="row between wrapme">
              <div><b>{c.name}</b> <span className="sub">{c.typeName}</span> {!c.enabled ? <Pill tone="mute">switched off</Pill> : c.ok === null ? <Pill tone="mute">waiting</Pill> : c.ok ? <Pill tone="ok">up</Pill> : <Pill tone="bad">down</Pill>}
                <div className="sub">{c.enabled ? `Checked ${ago(c.checkedAt)}${c.ok && c.ms !== null ? ` · answered in ${c.ms} ms` : ""}${c.uptime24h !== null ? ` · ${c.uptime24h}% up over 24 h` : ""}` : "Not being checked"}{!c.ok && c.lastOk ? ` · last worked ${ago(c.lastOk)}` : ""}</div>
                {c.ok === false && c.error && <div className="error sm">{c.error}</div>}</div>
              <div className="strip" title="Last 24 hours, oldest on the left">{c.strip.map((v, i) => <i key={i} className={v === null ? "" : v ? "up" : "down"} />)}</div>
            </div>
          </div>
        ))}
      </div>
      <button className="btn sm" onClick={openConnections}>Manage connections</button>
    </>
  );
}

function LogPanel() {
  const { settings } = useSettings();
  const [q, setQ] = useState(""); const [level, setLevel] = useState(""); const [source, setSource] = useState(""); const [range, setRange] = useState("");
  const [rows, setRows] = useState<Line[]>([]); const [sources, setSources] = useState<string[]>([]); const [more, setMore] = useState(false);
  const [auto, setAuto] = useState(true); const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const params = (before?: number) => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (level) p.set("level", level);
    if (source) p.set("source", source);
    if (range) p.set("since", String(Date.now() - Number(range) * 3600_000));
    if (before) p.set("before", String(before));
    return p;
  };
  const load = useCallback(async () => {
    const my = ++seq.current; setBusy(true);
    try {
      const p = params(); p.set("limit", "100");
      const r = await api.get<{ rows: Line[]; sources: string[]; more: boolean }>(`/api/logs?${p}`);
      if (my === seq.current) { setRows(r.rows); setSources(r.sources); setMore(r.more); }
    } catch { /* keep what is shown */ }
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, level, source, range]);
  useEffect(() => { const t = window.setTimeout(() => void load(), q ? 250 : 0); return () => window.clearTimeout(t); }, [load, q]);
  useEffect(() => { if (!auto) return; const t = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(t); }, [auto, load]);
  const older = async () => {
    const p = params(rows.at(-1)?.id); p.set("limit", "100");
    const r = await api.get<{ rows: Line[]; more: boolean }>(`/api/logs?${p}`);
    setRows(prev => [...prev, ...r.rows]); setMore(r.more);
  };
  const exportUrl = `/api/logs/export?${params()}`;

  return (
    <>
      <div className="logbar">
        <input type="search" className="logq" placeholder="Search the log, e.g. timed out, Sonarr, signed in, failed" value={q} onChange={e => setQ(e.target.value)} aria-label="Search the log" />
        <select value={level} onChange={e => setLevel(e.target.value)} aria-label="Level"><option value="">All levels</option><option value="warn">Warnings</option><option value="error">Errors</option><option value="info">Information</option></select>
        <select value={source} onChange={e => setSource(e.target.value)} aria-label="Area"><option value="">All areas</option>{sources.map(s => <option key={s} value={s}>{s}</option>)}</select>
        <select value={range} onChange={e => setRange(e.target.value)} aria-label="When"><option value="">Any time</option><option value="1">Last hour</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option></select>
        <label className="check"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Live</label>
        <a className="btn sm" href={exportUrl} download>Export CSV</a>
      </div>
      <div className="loglist" aria-busy={busy}>
        {rows.length === 0 && <p className="sub pad12">{busy ? "Searching…" : q || level || source || range ? "Nothing matches." : "The log is empty."}</p>}
        {rows.map(r => (
          <div key={r.id} className={`logrow ${r.level}`}>
            <span className="sub logt">{fmtDateTime(r.ts, settings)}</span><Pill tone={TONE[r.level]}>{r.level}</Pill><span className="sub logs">{r.source}</span><span className="logm">{r.message}</span>
          </div>
        ))}
      </div>
      {more && <button className="btn sm" onClick={() => void older()}>Show older</button>}
    </>
  );
}

export function StatusLogs({ openConnections }: { openConnections: () => void }) {
  const [tab, setTab] = useState<"status" | "log">("status");
  return (
    <Section title="Status and log">
      <div className="subtabs" role="tablist"><button role="tab" aria-selected={tab === "status"} className={tab === "status" ? "on" : ""} onClick={() => setTab("status")}>Status</button><button role="tab" aria-selected={tab === "log"} className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>Log</button></div>
      {tab === "status" ? <StatusPanel openConnections={openConnections} /> : <LogPanel />}
    </Section>
  );
}
