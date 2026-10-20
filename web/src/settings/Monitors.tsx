import { useEffect, useState } from "react";
import { api } from "../api";
import { Field, Modal } from "../dialogs/Modal";
import { groupRows } from "../components/MonitorBits";
import { useMonitors } from "../hooks";
import { fmtDateTime, useSettings } from "../settings";
import type { AboutInfo, AuthUser, IncidentPost, MaintenanceWindow, MonitorInfo, StatusPageInfo } from "../types";
import { Confirm, Pill } from "../widgets/common";
import { Row, Section, ago, copyText, useNotice } from "./ui";

/** Settings → Monitors: the monitors themselves live on the Monitoring tab; status pages and maintenance windows are set up here. */
export function Monitors({ me, about }: { me: AuthUser; about: AboutInfo | null }) {
  const { items } = useMonitors();
  if (me.role !== "admin") return null;
  return (
    <>
      <Section title="Monitoring" hint="Monitors are added, grouped and watched on the Monitoring tab at the top of the dashboard. Status pages and maintenance windows are managed here.">
        <Row label=""><a className="btn pri" href="#monitoring">Open the Monitoring tab</a></Row>
      </Section>
      <StatusPages monitors={items} about={about} />
      <Maintenance monitors={items} />
    </>
  );
}

function StatusPages({ monitors, about }: { monitors: MonitorInfo[]; about: AboutInfo | null }) {
  const { settings } = useSettings();
  const [pages, setPages] = useState<StatusPageInfo[]>([]);
  const [form, setForm] = useState<{ id?: string; title: string; message: string; tone: string; domain: string; monitors: string[] } | null>(null);
  const [posts, setPosts] = useState<StatusPageInfo | null>(null);
  const [embed, setEmbed] = useState<StatusPageInfo | null>(null);
  const [copied, setCopied] = useState("");
  const n = useNotice();
  const load = () => { void api.get<{ items: StatusPageInfo[] }>("/api/status-pages").then(r => setPages(r.items)).catch(() => {}); };
  useEffect(load, []);
  const base = settings.publicBaseUrl || (about?.publicPort ? `${window.location.protocol}//${window.location.hostname}:${about.publicPort}` : window.location.origin);
  const link = (p: StatusPageInfo) => p.domain ? `https://${p.domain}/` : `${base}${p.path}`;
  /** Where the page's data files live: on its own domain when it has one. */
  const api0 = (p: StatusPageInfo) => p.domain ? `https://${p.domain}/api/status/_host` : `${base}/api/status/${p.token}`;
  const names = (p: StatusPageInfo) => p.monitors.map(id => monitors.find(m => m.id === id)?.name).filter(Boolean).join(", ");
  const save = async () => {
    if (!form) return; n.clear();
    try { if (form.id) await api.put(`/api/status-pages/${form.id}`, form); else await api.post("/api/status-pages", form); setForm(null); load(); n.ok(form.id ? "Saved." : "Status page created. Copy its link below."); } catch (e) { n.bad(e); }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => { n.clear(); try { await fn(); load(); n.ok(ok); } catch (e) { n.bad(e); } };
  const copy = async (p: StatusPageInfo) => { if (await copyText(link(p))) { setCopied(p.id); window.setTimeout(() => setCopied(""), 1800); } };

  return (
    <Section title="Status pages" hint={<>A public page that shows chosen monitors: whether each is up, its uptime over the last 45 days (grouped the way you grouped them) and its last response time. It never shows addresses or error details. It opens on the sharing port{about?.publicPort ? ` (${about.publicPort})` : ""}, like camera links, so point your reverse proxy at that port only.</>}>
      {n.el}
      <Row label=""><button className="btn pri" disabled={!monitors.length} onClick={() => setForm({ title: "Status", message: "", tone: "info", domain: "", monitors: monitors.map(m => m.id) })}>＋ New status page</button>{!monitors.length && <span className="sub">Add a monitor first.</span>}</Row>
      {pages.length > 0 && <div className="rows">{pages.map(p => (
        <div key={p.id} className="srow col">
          <div className="row sp wrapme"><b>{p.title}</b><span>{p.enabled ? <Pill tone="ok">on</Pill> : <Pill tone="bad">switched off</Pill>} <span className="sub">{p.views} view{p.views === 1 ? "" : "s"}{p.lastUsed ? `, last ${ago(p.lastUsed)}` : ""}</span></span></div>
          <span className="sub">{names(p) || "no monitors left"}</span>
          {p.domain && <span className="sub">Own domain: <b>{p.domain}</b> (point it at the sharing port in your reverse proxy)</span>}
          <input readOnly className="linkbox" aria-label={`Link for ${p.title}`} value={link(p)} onFocus={e => e.currentTarget.select()} />
          <div className="row wrapme g8">
            <button className="btn sm" onClick={() => void copy(p)}>{copied === p.id ? "Copied" : "Copy link"}</button>
            <a className="btn sm" href={`${p.path}`} target="_blank" rel="noreferrer">Open ↗</a>
            <button className="btn sm" onClick={() => setPosts(p)}>Posts…</button>
            <button className="btn sm" onClick={() => setEmbed(p)}>Badges & RSS…</button>
            <button className="btn sm" onClick={() => setForm({ id: p.id, title: p.title, message: p.message, tone: p.tone, domain: p.domain, monitors: p.monitors })}>Edit</button>
            <button className="btn sm" onClick={() => void act(() => api.put(`/api/status-pages/${p.id}`, { enabled: !p.enabled }), p.enabled ? "Switched off." : "Switched on.")}>{p.enabled ? "Switch off" : "Switch on"}</button>
            <button className="btn sm" onClick={() => void act(() => api.post(`/api/status-pages/${p.id}/new-link`), "New link made. The old one no longer works.")}>New link</button>
            <Confirm label="Remove…" name={`Remove ${p.title}`} sure="Click again to remove it; its link stops working" onGo={() => void act(() => api.del(`/api/status-pages/${p.id}`), "Removed.")} />
          </div>
        </div>
      ))}</div>}
      {posts && <PostsDialog page={posts} onClose={() => setPosts(null)} />}
      {embed && (
        <Modal title="Badges and RSS" eyebrow={embed.title} onClose={() => setEmbed(null)} wide>
          <div className="form">
            <p className="sub">Anyone with these addresses can see them, so they show only what the status page shows. Badges are small SVG pictures for README files or other websites; the feed lists your posts.</p>
            {[
              { label: "Overall badge", url: `${api0(embed)}/badge` },
              { label: "RSS feed of posts", url: `${api0(embed)}/rss` },
              ...embed.monitors.map((id, i) => ({ label: `${monitors.find(m => m.id === id)?.name ?? "Monitor"}: status`, url: `${api0(embed)}/badge/${i + 1}` })),
              ...embed.monitors.map((id, i) => ({ label: `${monitors.find(m => m.id === id)?.name ?? "Monitor"}: uptime (30 days)`, url: `${api0(embed)}/badge/${i + 1}?type=uptime&days=30` }))
            ].map(r => (
              <Field key={r.label} label={r.label}><span className="row g8"><input readOnly className="linkbox f1" value={r.url} onFocus={e => e.currentTarget.select()} /><button type="button" className="btn sm" onClick={() => void copyText(r.url)}>Copy</button></span></Field>
            ))}
            <p className="sub">Add <code>?type=ping</code> for a response-time badge or <code>&label=Text</code> to change a badge's label. Monitors are numbered in the order they are listed on the page.</p>
          </div>
        </Modal>
      )}
      {form && (
        <Modal title={form.id ? "Edit status page" : "New status page"} eyebrow="Status pages" onClose={() => setForm(null)}>
          <div className="form">
            <Field label="Title"><input value={form.title} maxLength={80} onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
            <Field label="Message (optional)" hint="Shown under the title, for example “Planned maintenance on Sunday”."><input value={form.message} maxLength={400} onChange={e => setForm({ ...form, message: e.target.value })} /></Field>
            <Field label="Own domain (optional)" hint="For example status.example.com. Point that name at the sharing port in your reverse proxy (with HTTPS there). Homebase then shows this page at the front of that domain.">
              <input value={form.domain} maxLength={253} placeholder="status.example.com" onChange={e => setForm({ ...form, domain: e.target.value })} />
            </Field>
            <Field label="Message style"><select value={form.tone} onChange={e => setForm({ ...form, tone: e.target.value })}><option value="info">Information (neutral)</option><option value="warn">Warning (amber)</option><option value="bad">Problem (red)</option></select></Field>
            <div className="field"><span>Monitors to show</span>
              <span className="row g8">
                <button type="button" className="btn sm" onClick={() => setForm({ ...form, monitors: monitors.map(m => m.id) })}>Select all</button>
                <button type="button" className="btn sm" onClick={() => setForm({ ...form, monitors: [] })}>Select none</button>
              </span>
              <div className="list sec-pick">{groupRows(monitors).map(g => {
                const ids = g.rows.map(m => m.id), all = ids.every(id => form.monitors.includes(id));
                return (
                  <div key={g.name || "_"}>
                    {(g.name || groupRows(monitors).length > 1) && <div className="li"><label className="chk"><input type="checkbox" checked={all} onChange={e => setForm({ ...form, monitors: e.target.checked ? [...new Set([...form.monitors, ...ids])] : form.monitors.filter(x => !ids.includes(x)) })} /> <b>{g.name || "Other"}</b></label></div>}
                    {g.rows.map(m => (
                      <div key={m.id} className="li"><label className="chk"><input type="checkbox" checked={form.monitors.includes(m.id)} onChange={e => setForm({ ...form, monitors: e.target.checked ? [...form.monitors, m.id] : form.monitors.filter(x => x !== m.id) })} /> {m.name}</label></div>
                    ))}
                  </div>
                );
              })}</div>
            </div>
            <div className="acts"><span /><span className="acts-right"><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri" onClick={() => void save()}>Save</button></span></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toLocalInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
type WinForm = { id?: string; title: string; kind: "once" | "daily" | "weekly"; monitors: string[]; startsAt: string; endsAt: string; days: number[]; startTime: string; durationMin: number; enabled: boolean };

function Maintenance({ monitors }: { monitors: MonitorInfo[] }) {
  const { settings } = useSettings();
  const [items, setItems] = useState<MaintenanceWindow[]>([]);
  const [form, setForm] = useState<WinForm | null>(null);
  const n = useNotice();
  const load = () => { void api.get<{ items: MaintenanceWindow[] }>("/api/maintenance-windows").then(r => setItems(r.items)).catch(() => {}); };
  useEffect(load, []);
  const blank = (): WinForm => { const now = Date.now(); return { title: "", kind: "once", monitors: [], startsAt: toLocalInput(now), endsAt: toLocalInput(now + 3600_000), days: [], startTime: "02:00", durationMin: 60, enabled: true }; };
  const edit = (w: MaintenanceWindow): WinForm => ({ id: w.id, title: w.title, kind: w.kind, monitors: w.monitors, startsAt: toLocalInput(w.startsAt ?? Date.now()), endsAt: toLocalInput(w.endsAt ?? Date.now() + 3600_000), days: w.days, startTime: w.startTime, durationMin: w.durationMin, enabled: w.enabled });
  const when = (w: MaintenanceWindow) => w.kind === "once" ? `${fmtDateTime(w.startsAt ?? 0, settings)} to ${fmtDateTime(w.endsAt ?? 0, settings)}` : `${w.kind === "daily" ? "Every day" : w.days.map(d => DAYS[d]).join(", ")} at ${w.startTime} for ${w.durationMin} min`;
  const which = (w: MaintenanceWindow) => w.monitors.length ? w.monitors.map(id => monitors.find(m => m.id === id)?.name).filter(Boolean).join(", ") : "All monitors";
  const body = (f: WinForm) => ({ title: f.title, kind: f.kind, monitors: f.monitors, enabled: f.enabled, startsAt: new Date(f.startsAt).getTime(), endsAt: new Date(f.endsAt).getTime(), days: f.days, startTime: f.startTime, durationMin: f.durationMin });
  const save = async () => {
    if (!form) return; n.clear();
    try { if (form.id) await api.put(`/api/maintenance-windows/${form.id}`, body(form)); else await api.post("/api/maintenance-windows", body(form)); setForm(null); load(); n.ok("Saved."); } catch (e) { n.bad(e); }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => { n.clear(); try { await fn(); load(); n.ok(ok); } catch (e) { n.bad(e); } };
  return (
    <Section title="Maintenance windows" hint="Planned work. While a window is active the chosen monitors are shown as “Maintenance”: they are not checked, do not count against uptime, and no down alerts are logged. Times follow the time zone in General settings.">
      {n.el}
      <Row label=""><button className="btn pri" onClick={() => setForm(blank())}>＋ New maintenance window</button></Row>
      {items.length > 0 && <div className="rows">{items.map(w => (
        <div key={w.id} className="srow col">
          <div className="row sp wrapme"><b>{w.title}</b>{w.enabled ? <Pill tone="ok">on</Pill> : <Pill tone="mute">off</Pill>}</div>
          <span className="sub">{when(w)}</span>
          <span className="sub">{which(w)}</span>
          <div className="row wrapme g8">
            <button className="btn sm" onClick={() => setForm(edit(w))}>Edit</button>
            <button className="btn sm" onClick={() => void act(() => api.put(`/api/maintenance-windows/${w.id}`, { enabled: !w.enabled }), w.enabled ? "Switched off." : "Switched on.")}>{w.enabled ? "Switch off" : "Switch on"}</button>
            <Confirm label="Remove…" name={`Remove ${w.title}`} sure="Click again to remove it" onGo={() => void act(() => api.del(`/api/maintenance-windows/${w.id}`), "Removed.")} />
          </div>
        </div>
      ))}</div>}
      {form && (
        <Modal title={form.id ? "Edit maintenance window" : "New maintenance window"} eyebrow="Maintenance" onClose={() => setForm(null)}>
          <div className="form">
            <div className="row2">
              <Field label="Title"><input value={form.title} maxLength={80} placeholder="Weekly patching" onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
              <Field label="Repeats"><select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as WinForm["kind"] })}><option value="once">Once</option><option value="daily">Every day</option><option value="weekly">On chosen days</option></select></Field>
            </div>
            {form.kind === "once" ? (
              <div className="row2">
                <Field label="Starts"><input type="datetime-local" value={form.startsAt} onChange={e => setForm({ ...form, startsAt: e.target.value })} /></Field>
                <Field label="Ends"><input type="datetime-local" value={form.endsAt} onChange={e => setForm({ ...form, endsAt: e.target.value })} /></Field>
              </div>
            ) : (
              <>
                <div className="row2">
                  <Field label="Starts at (24-hour time)"><input type="time" value={form.startTime} onChange={e => setForm({ ...form, startTime: e.target.value })} /></Field>
                  <Field label="Lasts (minutes)" hint="Up to 1440. It may run past midnight."><input type="number" min={1} max={1440} value={form.durationMin} onChange={e => setForm({ ...form, durationMin: Number(e.target.value) })} /></Field>
                </div>
                {form.kind === "weekly" && <div className="row g8 wrapme">{DAYS.map((d, i) => (
                  <label key={d} className="chk"><input type="checkbox" checked={form.days.includes(i)} onChange={e => setForm({ ...form, days: e.target.checked ? [...form.days, i] : form.days.filter(x => x !== i) })} /> {d}</label>
                ))}</div>}
              </>
            )}
            <div className="field"><span>Monitors affected</span>
              <span className="row g8">
                <button type="button" className="btn sm" onClick={() => setForm({ ...form, monitors: [] })}>All monitors</button>
                <button type="button" className="btn sm" onClick={() => setForm({ ...form, monitors: monitors.map(m => m.id) })}>Choose from the list</button>
              </span>
              {form.monitors.length > 0 && <div className="list sec-pick">{monitors.map(m => (
                <div key={m.id} className="li"><label className="chk"><input type="checkbox" checked={form.monitors.includes(m.id)} onChange={e => setForm({ ...form, monitors: e.target.checked ? [...form.monitors, m.id] : form.monitors.filter(x => x !== m.id) })} /> {m.name}{m.group ? <span className="sub"> · {m.group}</span> : null}</label></div>
              ))}</div>}
              <small>{form.monitors.length ? `${form.monitors.length} chosen.` : "No monitor chosen: the window applies to all of them."}</small></div>
            <div className="acts"><span /><span className="acts-right"><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri" onClick={() => void save()}>Save</button></span></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

const STYLES = [["info", "Information"], ["warn", "Warning"], ["bad", "Outage"], ["ok", "Good news"]] as const;
type PostForm = { id?: string; title: string; body: string; style: string; pinned: boolean };

function PostsDialog({ page, onClose }: { page: StatusPageInfo; onClose: () => void }) {
  const { settings } = useSettings();
  const [items, setItems] = useState<IncidentPost[]>([]);
  const [form, setForm] = useState<PostForm | null>(null);
  const n = useNotice();
  const load = () => { void api.get<{ items: IncidentPost[] }>(`/api/status-pages/${page.id}/incidents`).then(r => setItems(r.items)).catch(() => {}); };
  useEffect(load, [page.id]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { n.clear(); try { await fn(); load(); n.ok(ok); } catch (e) { n.bad(e); } };
  const save = async () => {
    if (!form) return;
    await act(async () => { if (form.id) await api.put(`/api/status-incidents/${form.id}`, form); else await api.post(`/api/status-pages/${page.id}/incidents`, form); setForm(null); }, "Saved. It shows on the page right away.");
  };
  return (
    <Modal title="Posts" eyebrow={page.title} onClose={onClose} wide>
      <div className="form">
        <p className="sub">Announcements shown at the top of the status page, such as an outage or planned work. Edit a post as things change and mark it resolved when it is over. Resolved posts stay visible for 14 days.</p>
        {n.el}
        {!form && <div><button className="btn pri" onClick={() => setForm({ title: "", body: "", style: "info", pinned: true })}>＋ New post</button></div>}
        {form ? (
          <>
            <div className="row2">
              <Field label="Title"><input value={form.title} maxLength={120} placeholder="Slow downloads on the NAS" onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
              <Field label="Style"><select value={form.style} onChange={e => setForm({ ...form, style: e.target.value })}>{STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            </div>
            <Field label="Details (optional)"><textarea rows={4} value={form.body} maxLength={2000} onChange={e => setForm({ ...form, body: e.target.value })} /></Field>
            <label className="chk"><input type="checkbox" checked={form.pinned} onChange={e => setForm({ ...form, pinned: e.target.checked })} /> Pin to the top of the page</label>
            <div className="acts"><span /><span className="acts-right"><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri" onClick={() => void save()}>Save</button></span></div>
          </>
        ) : items.length ? (
          <div className="rows">{items.map(i => (
            <div key={i.id} className="srow col">
              <div className="row sp wrapme"><b>{i.title}</b><span className="row g8"><Pill tone={i.style === "ok" ? "ok" : i.style === "bad" ? "bad" : i.style === "warn" ? "warn" : "mute"}>{STYLES.find(x => x[0] === i.style)?.[1]}</Pill>{i.resolvedAt ? <Pill tone="mute">resolved</Pill> : i.pinned ? <Pill tone="mute">pinned</Pill> : null}</span></div>
              {i.body && <span className="sub">{i.body}</span>}
              <span className="sub">Posted {fmtDateTime(i.createdAt, settings)}{i.updatedAt > i.createdAt + 1000 ? `, updated ${ago(i.updatedAt)}` : ""}</span>
              <div className="row wrapme g8">
                <button className="btn sm" onClick={() => setForm({ id: i.id, title: i.title, body: i.body, style: i.style, pinned: i.pinned })}>Edit</button>
                <button className="btn sm" onClick={() => void act(() => api.put(`/api/status-incidents/${i.id}`, { resolved: !i.resolvedAt }), i.resolvedAt ? "Reopened." : "Marked resolved.")}>{i.resolvedAt ? "Reopen" : "Mark resolved"}</button>
                <Confirm label="Remove…" name={`Remove ${i.title}`} sure="Click again to remove it" onGo={() => void act(() => api.del(`/api/status-incidents/${i.id}`), "Removed.")} />
              </div>
            </div>
          ))}</div>
        ) : <p className="sub">No posts yet.</p>}
      </div>
    </Modal>
  );
}
