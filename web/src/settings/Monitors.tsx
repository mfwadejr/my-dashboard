import { useEffect, useState } from "react";
import { api } from "../api";
import { Field, Modal } from "../dialogs/Modal";
import { StateDot, STATE_LABEL, Strip, fmtMs, fmtPct } from "../components/MonitorBits";
import { useMonitors } from "../hooks";
import { fmtDateTime, useSettings } from "../settings";
import type { AboutInfo, AuthUser, MonitorConfigInfo, MonitorInfo, StatusPageInfo } from "../types";
import { Confirm, Pill } from "../widgets/common";
import { Row, Section, ago, copyText, useNotice } from "./ui";

const KINDS = [["http", "Website (address)"], ["keyword", "Website with a word on the page"], ["tcp", "Port (is a service listening)"], ["dns", "DNS name"]] as const;
const BLANK = { kind: "http", name: "", target: "", port: "", keyword: "", invert: false, expect: "200-299", method: "GET", dnsType: "A", dnsServer: "", intervalSeconds: 60, timeoutSeconds: 10, retries: 1, insecureTls: false, certWarnDays: 14 };
type Form = typeof BLANK;

const describe = (c: MonitorConfigInfo) => c.kind === "tcp" ? `${c.target}:${c.port}` : c.kind === "dns" ? `${c.dnsType} ${c.target}` : c.target.replace(/^https?:\/\//, "");

export function Monitors({ me, about }: { me: AuthUser; about: AboutInfo | null }) {
  const admin = me.role === "admin";
  const { items, loaded, reload } = useMonitors();
  const n = useNotice();
  const [editing, setEditing] = useState<{ id?: string; form: Form } | null>(null);
  const { settings } = useSettings();
  const [busy, setBusy] = useState("");

  const checkNow = async (id: string) => {
    setBusy(id); n.clear();
    try { const r = await api.post<{ up: boolean; message: string }>(`/api/monitors/${id}/check`); n.setNote({ ok: r.up, text: r.up ? `Checked: ${r.message}` : `Checked: ${r.message}` }); await reload(); } catch (e) { n.bad(e); }
    setBusy("");
  };
  const toggle = async (m: MonitorInfo) => { try { await api.put(`/api/monitors/${m.id}`, { enabled: !m.enabled }); await reload(); } catch (e) { n.bad(e); } };
  const remove = async (m: MonitorInfo) => { try { await api.del(`/api/monitors/${m.id}`); await reload(); n.ok(`Removed "${m.name}".`); } catch (e) { n.bad(e); } };
  const edit = (m: MonitorInfo) => m.config && setEditing({ id: m.id, form: { ...BLANK, ...m.config, port: m.config.port ? String(m.config.port) : "" } as Form });

  return (
    <>
      <Section title="Monitors" hint="Homebase checks these on a schedule from this machine, keeps the history, and writes down and up changes to the log. It does what Uptime Kuma does for websites, ports and DNS names.">
        {n.el}
        {admin && <Row label=""><button className="btn pri" onClick={() => setEditing({ form: { ...BLANK } })}>＋ Add a monitor</button></Row>}
        {!loaded ? <p className="sub">Loading…</p> : !items.length ? <p className="sub">No monitors yet.{admin ? " Add one to start keeping watch." : ""}</p> : (
          <div className="rows">{items.map(m => (
            <div key={m.id} className="srow col">
              <div className="row sp wrapme">
                <span className="row g8 f1"><StateDot state={m.state} /><b className="trunc">{m.name}</b>
                  {m.config && <span className="sub trunc">{describe(m.config)}</span>}</span>
                <Strip checks={m.strip} count={30} />
              </div>
              <div className="statline">
                <span><b>{STATE_LABEL[m.state]}</b>{m.since && m.state !== "unknown" && m.state !== "paused" ? ` for ${ago(m.since).replace(" ago", "")}` : ""}</span>
                <span>Response <b>{fmtMs(m.lastMs)}</b>{m.avgMs24h !== null ? ` (avg ${fmtMs(m.avgMs24h)})` : ""}</span>
                <span>Uptime <b>{fmtPct(m.uptime24h)}</b> day · <b>{fmtPct(m.uptime7d)}</b> week · <b>{fmtPct(m.uptime30d)}</b> month</span>
                {m.certExpires && <span>Certificate ends <b>{fmtDateTime(m.certExpires, settings)}</b></span>}
              </div>
              {m.state === "down" || m.state === "pending" ? <p className="error sm">{m.message}</p> : null}
              {admin && (
                <div className="row wrapme g8">
                  <button className="btn sm" disabled={busy === m.id} onClick={() => void checkNow(m.id)}>{busy === m.id ? "Checking…" : "Check now"}</button>
                  <button className="btn sm" onClick={() => edit(m)}>Edit</button>
                  <button className="btn sm" onClick={() => void toggle(m)}>{m.enabled ? "Pause" : "Resume"}</button>
                  <Confirm label="Remove…" name={`Remove ${m.name}`} sure="Click again to remove it and its history" onGo={() => void remove(m)} />
                </div>
              )}
            </div>
          ))}</div>
        )}
      </Section>
      {admin && <StatusPages monitors={items} about={about} />}
      {editing && <MonitorForm start={editing} onClose={() => setEditing(null)} onSaved={async text => { setEditing(null); await reload(); n.ok(text); }} />}
    </>
  );
}

function MonitorForm({ start, onClose, onSaved }: { start: { id?: string; form: Form }; onClose: () => void; onSaved: (text: string) => void }) {
  const [f, setF] = useState<Form>(start.form);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF(x => ({ ...x, [k]: v }));
  const web = f.kind === "http" || f.kind === "keyword";
  const body = () => ({ ...f, port: f.port === "" ? 0 : Number(f.port) });
  const test = async () => {
    setBusy("test"); setMsg(null);
    try { const r = await api.post<{ up: boolean; message: string; ms: number | null }>("/api/monitors/test", body()); setMsg({ ok: r.up, text: `${r.up ? "Works" : "Fails"}: ${r.message}${r.ms !== null ? ` (${r.ms} ms)` : ""}` }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not test" }); }
    setBusy("");
  };
  const save = async () => {
    setBusy("save"); setMsg(null);
    try { if (start.id) await api.put(`/api/monitors/${start.id}`, body()); else await api.post("/api/monitors", body()); onSaved(start.id ? "Saved." : "Monitor added. It is checked right away."); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not save" }); setBusy(""); }
  };
  return (
    <Modal title={start.id ? "Edit monitor" : "Add a monitor"} eyebrow="Monitors" onClose={onClose} wide>
      <div className="form">
        <div className="row2">
          <Field label="What to check"><select value={f.kind} onChange={e => set("kind", e.target.value)}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Name"><input value={f.name} maxLength={60} placeholder="Shown on the dashboard" onChange={e => set("name", e.target.value)} /></Field>
        </div>
        {web ? <Field label="Address" hint="The full address, for example https://nas.example.com or http://192.168.1.10:8989."><input value={f.target} placeholder="https://" onChange={e => set("target", e.target.value)} /></Field>
          : <div className="row2">
            <Field label={f.kind === "dns" ? "Name to look up" : "Host"} hint={f.kind === "dns" ? "For example example.com" : "A host name or IP address."}><input value={f.target} onChange={e => set("target", e.target.value)} /></Field>
            {f.kind === "tcp" ? <Field label="Port"><input inputMode="numeric" value={f.port} onChange={e => set("port", e.target.value.replace(/\D/g, "").slice(0, 5))} /></Field>
              : <Field label="Record type"><select value={f.dnsType} onChange={e => set("dnsType", e.target.value)}>{["A", "AAAA", "CNAME", "MX", "TXT", "NS"].map(t => <option key={t}>{t}</option>)}</select></Field>}
          </div>}
        {f.kind === "keyword" && (
          <div className="row2">
            <Field label="Word or phrase on the page" hint="Not case sensitive."><input value={f.keyword} maxLength={200} onChange={e => set("keyword", e.target.value)} /></Field>
            <Field label="Counts as up when"><select value={f.invert ? "absent" : "present"} onChange={e => set("invert", e.target.value === "absent")}><option value="present">The word is on the page</option><option value="absent">The word is NOT on the page</option></select></Field>
          </div>
        )}
        {f.kind === "dns" && (
          <div className="row2">
            <Field label="Answer must contain (optional)"><input value={f.keyword} maxLength={200} onChange={e => set("keyword", e.target.value)} /></Field>
            <Field label="Ask this DNS server (optional)" hint="An IP address such as 192.168.1.1. Empty uses this machine's own."><input value={f.dnsServer} onChange={e => set("dnsServer", e.target.value)} /></Field>
          </div>
        )}
        {web && (
          <div className="row2">
            <Field label="Status codes that count as up" hint="For example 200-299 or 200,301,404."><input value={f.expect} onChange={e => set("expect", e.target.value)} /></Field>
            {f.kind === "http" ? <Field label="Request"><select value={f.method} onChange={e => set("method", e.target.value)}><option value="GET">GET (normal)</option><option value="HEAD">HEAD (headers only)</option></select></Field> : <span />}
          </div>
        )}
        <div className="row2">
          <Field label="Check every (seconds)" hint="At least 20."><input type="number" min={20} max={86400} value={f.intervalSeconds} onChange={e => set("intervalSeconds", Number(e.target.value))} /></Field>
          <Field label="Give up after (seconds)"><input type="number" min={1} max={60} value={f.timeoutSeconds} onChange={e => set("timeoutSeconds", Number(e.target.value))} /></Field>
        </div>
        <div className="row2">
          <Field label="Retries before it counts as down" hint="A failed check is repeated every 20 seconds or so before the monitor is shown as down."><input type="number" min={0} max={10} value={f.retries} onChange={e => set("retries", Number(e.target.value))} /></Field>
          {web ? <Field label="Warn when the certificate ends within (days)" hint="0 turns the warning off."><input type="number" min={0} max={365} value={f.certWarnDays} onChange={e => set("certWarnDays", Number(e.target.value))} /></Field> : <span />}
        </div>
        {web && <label className="chk"><input type="checkbox" checked={f.insecureTls} onChange={e => set("insecureTls", e.target.checked)} /> Allow a self-signed or expired certificate (https addresses only)</label>}
        {msg && <p className={msg.ok ? "ok-note" : "error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
        <div className="acts">
          <button className="btn" disabled={busy !== ""} onClick={() => void test()}>{busy === "test" ? "Testing…" : "Test"}</button>
          <span className="acts-right"><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy !== ""} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save"}</button></span>
        </div>
      </div>
    </Modal>
  );
}

function StatusPages({ monitors, about }: { monitors: MonitorInfo[]; about: AboutInfo | null }) {
  const { settings } = useSettings();
  const [pages, setPages] = useState<StatusPageInfo[]>([]);
  const [form, setForm] = useState<{ id?: string; title: string; message: string; monitors: string[] } | null>(null);
  const [copied, setCopied] = useState("");
  const n = useNotice();
  const load = () => { void api.get<{ items: StatusPageInfo[] }>("/api/status-pages").then(r => setPages(r.items)).catch(() => {}); };
  useEffect(load, []);
  const base = settings.publicBaseUrl || (about?.publicPort ? `${window.location.protocol}//${window.location.hostname}:${about.publicPort}` : window.location.origin);
  const link = (p: StatusPageInfo) => `${base}${p.path}`;
  const names = (p: StatusPageInfo) => p.monitors.map(id => monitors.find(m => m.id === id)?.name).filter(Boolean).join(", ");
  const save = async () => {
    if (!form) return; n.clear();
    try { if (form.id) await api.put(`/api/status-pages/${form.id}`, form); else await api.post("/api/status-pages", form); setForm(null); load(); n.ok(form.id ? "Saved." : "Status page created. Copy its link below."); } catch (e) { n.bad(e); }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => { n.clear(); try { await fn(); load(); n.ok(ok); } catch (e) { n.bad(e); } };
  const copy = async (p: StatusPageInfo) => { if (await copyText(link(p))) { setCopied(p.id); window.setTimeout(() => setCopied(""), 1800); } };

  return (
    <Section title="Status pages" hint={<>A public page that shows chosen monitors: whether each is up, its uptime over the last 45 days and its last response time. It never shows addresses or error details. It opens on the sharing port{about?.publicPort ? ` (${about.publicPort})` : ""}, like camera links, so point your reverse proxy at that port only.</>}>
      {n.el}
      <Row label=""><button className="btn pri" disabled={!monitors.length} onClick={() => setForm({ title: "Status", message: "", monitors: monitors.map(m => m.id) })}>＋ New status page</button>{!monitors.length && <span className="sub">Add a monitor first.</span>}</Row>
      {pages.length > 0 && <div className="rows">{pages.map(p => (
        <div key={p.id} className="srow col">
          <div className="row sp wrapme"><b>{p.title}</b><span>{p.enabled ? <Pill tone="ok">on</Pill> : <Pill tone="bad">switched off</Pill>} <span className="sub">{p.views} view{p.views === 1 ? "" : "s"}{p.lastUsed ? `, last ${ago(p.lastUsed)}` : ""}</span></span></div>
          <span className="sub">{names(p) || "no monitors left"}</span>
          <input readOnly className="linkbox" aria-label={`Link for ${p.title}`} value={link(p)} onFocus={e => e.currentTarget.select()} />
          <div className="row wrapme g8">
            <button className="btn sm" onClick={() => void copy(p)}>{copied === p.id ? "Copied" : "Copy link"}</button>
            <a className="btn sm" href={`${p.path}`} target="_blank" rel="noreferrer">Open ↗</a>
            <button className="btn sm" onClick={() => setForm({ id: p.id, title: p.title, message: p.message, monitors: p.monitors })}>Edit</button>
            <button className="btn sm" onClick={() => void act(() => api.put(`/api/status-pages/${p.id}`, { enabled: !p.enabled }), p.enabled ? "Switched off." : "Switched on.")}>{p.enabled ? "Switch off" : "Switch on"}</button>
            <button className="btn sm" onClick={() => void act(() => api.post(`/api/status-pages/${p.id}/new-link`), "New link made. The old one no longer works.")}>New link</button>
            <Confirm label="Remove…" name={`Remove ${p.title}`} sure="Click again to remove it; its link stops working" onGo={() => void act(() => api.del(`/api/status-pages/${p.id}`), "Removed.")} />
          </div>
        </div>
      ))}</div>}
      {form && (
        <Modal title={form.id ? "Edit status page" : "New status page"} eyebrow="Status pages" onClose={() => setForm(null)}>
          <div className="form">
            <Field label="Title"><input value={form.title} maxLength={80} onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
            <Field label="Message (optional)" hint="Shown under the title, for example “Planned maintenance on Sunday”."><input value={form.message} maxLength={400} onChange={e => setForm({ ...form, message: e.target.value })} /></Field>
            <div className="field"><span>Monitors to show</span>
              <span className="row g8">
                <button type="button" className="btn sm" onClick={() => setForm({ ...form, monitors: monitors.map(m => m.id) })}>Select all</button>
                <button type="button" className="btn sm" onClick={() => setForm({ ...form, monitors: [] })}>Select none</button>
              </span>
              <div className="list sec-pick">{monitors.map(m => (
                <div key={m.id} className="li"><label className="chk"><input type="checkbox" checked={form.monitors.includes(m.id)} onChange={e => setForm({ ...form, monitors: e.target.checked ? [...form.monitors, m.id] : form.monitors.filter(x => x !== m.id) })} /> {m.name}</label></div>
              ))}</div>
            </div>
            <div className="acts"><span /><span className="acts-right"><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri" onClick={() => void save()}>Save</button></span></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}
