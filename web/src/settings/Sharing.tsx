import { useEffect, useState } from "react";
import { api } from "../api";
import { Confirm, Pill } from "../widgets/common";
import { fmtDateTime, useSettings } from "../settings";
import type { AboutInfo, CameraInfo } from "../types";
import { Row, Section, copyText, useNotice } from "./ui";

interface Share { id: string; name: string; kind: "cameras" | "kiosk"; cameras: string[]; expiresAt: number | null; revoked: boolean; createdAt: number; lastUsed: number | null; views: number; hasPin: boolean; token: string }

export function Sharing({ cameras, about }: { cameras: CameraInfo[]; about: AboutInfo | null }) {
  const { settings } = useSettings();
  const [list, setList] = useState<Share[]>([]);
  const [form, setForm] = useState({ name: "", kind: "cameras" as "cameras" | "kiosk", cameras: [] as string[], expiresIn: "7d", pin: "" });
  const n = useNotice();
  const [copied, setCopied] = useState("");
  const load = () => { void api.get<Share[]>("/api/shares").then(setList).catch(() => {}); };
  useEffect(load, []);

  // Camera links open on the public port (through your proxy). Wall-display links only work at home, on the normal address.
  const homeBase = window.location.origin;
  const publicBase = settings.publicBaseUrl || (about?.publicPort ? `${window.location.protocol}//${window.location.hostname}:${about.publicPort}` : homeBase);
  const link = (s: Share) => `${s.kind === "kiosk" ? homeBase : publicBase}/s/${s.token}`;
  const toggle = (id: string) => setForm(f => ({ ...f, cameras: f.cameras.includes(id) ? f.cameras.filter(c => c !== id) : [...f.cameras, id] }));
  const state = (s: Share) => s.revoked ? <Pill tone="bad">revoked</Pill> : s.expiresAt && s.expiresAt < Date.now() ? <Pill tone="bad">expired</Pill> : <Pill tone="ok">active</Pill>;
  const names = (s: Share) => s.cameras.map(id => cameras.find(c => c.id === id)?.name).filter(Boolean).join(", ") || "no cameras left";

  const create = async () => {
    n.clear();
    try { await api.post("/api/shares", form); n.ok("Link created. Copy it below."); setForm({ name: "", kind: form.kind, cameras: [], expiresIn: form.expiresIn, pin: "" }); load(); } catch (e) { n.bad(e); }
  };
  const copy = async (s: Share) => {
    if (await copyText(link(s))) { setCopied(s.id); window.setTimeout(() => setCopied(""), 2000); }
    else { setCopied(`select:${s.id}`); window.setTimeout(() => document.querySelector<HTMLInputElement>(`input[data-link="${s.id}"]`)?.select(), 0); }
  };

  return (
    <>
      <Section title="Share a link" hint="Give someone a link to watch one or several cameras, without an account and without seeing anything else. You choose how long it works and can switch it off at any time.">
        <Row label="Name" hint="Only for you, for example Neighbour – driveway."><input value={form.name} maxLength={60} onChange={e => setForm({ ...form, name: e.target.value })} /></Row>
        <Row label="What it shows"><select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as any })}><option value="cameras">Chosen cameras (works from outside)</option><option value="kiosk">The whole dashboard, read-only (home network only, for a wall display)</option></select></Row>
        {form.kind === "cameras" && (
          <Row label="Cameras">
            {cameras.length === 0 ? <span className="sub">Add a camera to a tile first.</span> : <div className="camchecks">{cameras.map(c => <label key={c.id} className="check"><input type="checkbox" checked={form.cameras.includes(c.id)} onChange={() => toggle(c.id)} /> {c.name}</label>)}</div>}
          </Row>
        )}
        <Row label="Lasts"><select value={form.expiresIn} onChange={e => setForm({ ...form, expiresIn: e.target.value })}><option value="1h">1 hour</option><option value="1d">1 day</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="never">Until I switch it off</option></select></Row>
        <Row label="PIN (optional)" hint="If set, people must enter it after opening the link. Tell them separately."><input value={form.pin} maxLength={32} autoComplete="off" onChange={e => setForm({ ...form, pin: e.target.value })} /></Row>
        <Row label=""><button className="btn pri" disabled={!form.name.trim() || (form.kind === "cameras" && form.cameras.length === 0)} onClick={() => void create()}>Create link</button></Row>
        {n.el}
      </Section>

      <Section title="Your links">
        {list.length === 0 ? <p className="sub">Nothing is shared.</p> : (
          <div className="rows">{list.map(s => (
            <div key={s.id} className="srow col">
              <div className="row between wrapme"><div><b>{s.name}</b> {state(s)} {s.hasPin && <Pill tone="mute">PIN</Pill>} {s.kind === "kiosk" && <Pill tone="warn">wall display</Pill>}
                <div className="sub">{s.kind === "kiosk" ? "Whole dashboard, read-only" : names(s)} · {s.expiresAt ? `ends ${fmtDateTime(s.expiresAt, settings)}` : "no end date"} · opened {s.views} time(s){s.lastUsed ? `, last ${fmtDateTime(s.lastUsed, settings)}` : ""}</div></div>
                <span className="row">
                  {!s.revoked && <button className="btn sm" onClick={() => void copy(s)}>{copied === s.id ? "Copied" : "Copy link"}</button>}
                  {!s.revoked && <Confirm label="Switch off" name="Switch off" sure="Sure?" onGo={async () => { await api.post(`/api/shares/${s.id}/revoke`); load(); }} />}
                  <Confirm label="Delete" name="Delete" sure="Sure?" onGo={async () => { await api.del(`/api/shares/${s.id}`); load(); }} />
                </span></div>
              {!s.revoked && <input readOnly className={`linkbox${copied === `select:${s.id}` ? " hot" : ""}`} value={link(s)} onFocus={e => e.currentTarget.select()} aria-label="Link" data-link={s.id} />}
            </div>
          ))}</div>
        )}
      </Section>

      <Section title="Letting people reach it from outside" hint="Homebase stays on your network. Only camera links need to be reachable from outside, and they use a separate door.">
        <ul className="help">
          <li><b>Two ports.</b> Port 3000 is the dashboard: sign-in, settings, everything. {about?.publicPort ? <>Port <b>{about.publicPort}</b> is the sharing door: it answers share links and camera video for those links, and nothing else. Even if your proxy is set up too widely, the dashboard is not on that port.</> : <>The sharing door (port 3001) is switched off right now. Set PUBLIC_PORT to turn it on.</>}</li>
          <li><b>Point your reverse proxy at the sharing port only</b> (for example https://cams.example.com → this machine, port {about?.publicPort ?? 3001}). Never publish port 3000 to the internet. Use HTTPS, and forward the real visitor address (X-Forwarded-For), then set TRUST_PROXY=true so limits and the log see it.</li>
          <li><b>Set the public address</b> under General so the links above point there.{settings.publicBaseUrl ? "" : <> It is empty now, so links use this computer's address and will not work from outside.</>}</li>
          <li><b>Wall-display links</b> never work through the sharing port. Open them on your home network only.</li>
          <li>Guessing a link is not practical (about 190 bits), wrong tries are limited per address, every use is written to the log, and switching a link off ends its open sessions immediately.</li>
        </ul>
      </Section>
    </>
  );
}
