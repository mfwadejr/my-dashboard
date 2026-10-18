import { useEffect, useState } from "react";
import { api } from "../api";
import { Confirm } from "../widgets/common";
import { fmtDateTime, useSettings } from "../settings";
import { Row, Section, useNotice } from "./ui";

interface Dest { id: string; name: string; kind: "sftp" | "smb"; host: string; port: number; share: string; path: string; username: string; domain: string; hasPassword: boolean; hostKey: string; enabled: boolean; keep: number; lastAt: number | null; lastOk: boolean | null; lastMessage: string }
interface Form { id: string; name: string; kind: "sftp" | "smb"; host: string; port: string; share: string; path: string; username: string; domain: string; password: string; keep: string; enabled: boolean }
const blank = (): Form => ({ id: "", name: "", kind: "sftp", host: "", port: "", share: "", path: "homebase", username: "", domain: "", password: "", keep: "14", enabled: true });

/** Places on the network that every finished database copy is sent to (nothing is mounted in the container). */
export function Destinations() {
  const { settings } = useSettings();
  const [items, setItems] = useState<Dest[]>([]);
  const [smbOk, setSmbOk] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState("");
  const n = useNotice(), f = useNotice();
  const load = () => api.get<{ items: Dest[]; smbAvailable: boolean }>("/api/backup/destinations").then(r => { setItems(r.items); setSmbOk(r.smbAvailable); }).catch(() => {});
  useEffect(() => { void load(); }, []);

  const set = (patch: Partial<Form>) => setForm(v => (v ? { ...v, ...patch } : v));
  const edit = (d: Dest) => setForm({ id: d.id, name: d.name, kind: d.kind, host: d.host, port: String(d.port), share: d.share, path: d.path, username: d.username, domain: d.domain, password: "", keep: String(d.keep), enabled: d.enabled });
  const saveForm = async () => {
    if (!form) return;
    f.clear();
    const body = { name: form.name, kind: form.kind, host: form.host, port: form.port || undefined, share: form.share, path: form.path, username: form.username, domain: form.domain, keep: form.keep, enabled: form.enabled, ...(form.password ? { password: form.password } : {}) };
    try {
      const saved = form.id ? await api.put<Dest>(`/api/backup/destinations/${form.id}`, body) : await api.post<Dest>("/api/backup/destinations", body);
      setForm(null); await load(); n.ok(form.id ? "Saved. Press Test to check it." : "Added. Press Test to check it and trust the server."); void saved;
    } catch (e) { f.bad(e); }
  };
  const run = async (id: string, what: "test" | "send") => {
    n.clear(); setBusy(id + what);
    try { const r = await api.post<{ ok: boolean; message: string }>(`/api/backup/destinations/${id}/${what}`, {}); if (r.ok) n.ok(r.message); else n.bad(new Error(r.message)); await load(); }
    catch (e) { n.bad(e); } finally { setBusy(""); }
  };

  return (
    <Section title="Copy backups to the network" hint="After every scheduled copy (and whenever you press Send), Homebase sends the copy to the places below, straight from the container, so nothing needs to be mounted. Create a dedicated account on your NAS that can only write to one folder, and use that here.">
      {items.length === 0 && !form && <p className="sub">No network places yet.</p>}
      <div className="rows">
        {items.map(d => (
          <div key={d.id} className="srow col">
            <div className="row wrapme between">
              <div className="trunc"><b>{d.name}</b> <span className="badge">{d.kind.toUpperCase()}</span>{!d.enabled && <span className="badge">switched off</span>}
                <div className="sub">{d.username}@{d.host}:{d.port}{d.kind === "smb" ? `/${d.share}` : ""}/{d.path} · keeps {d.keep}</div>
                <div className={d.lastOk === false ? "error" : "sub"}>{d.lastAt ? `${fmtDateTime(d.lastAt, settings)} · ` : ""}{d.lastMessage}</div></div>
              <span className="row wrapme">
                <button className="btn sm" disabled={busy === d.id + "test"} onClick={() => void run(d.id, "test")}>{busy === d.id + "test" ? "Testing…" : "Test"}</button>
                <button className="btn sm" disabled={busy === d.id + "send"} onClick={() => void run(d.id, "send")}>{busy === d.id + "send" ? "Sending…" : "Send latest copy now"}</button>
                <button className="btn sm" onClick={() => edit(d)}>Edit</button>
                <Confirm label="Remove" name={`Remove ${d.name}`} sure="Sure?" onGo={async () => { try { await api.del(`/api/backup/destinations/${d.id}`); void load(); } catch (e) { n.bad(e); } }} />
              </span>
            </div>
          </div>
        ))}
      </div>
      {n.el}
      {!form && <Row label=""><button className="btn" onClick={() => setForm(blank())}>Add a network place…</button></Row>}
      {form && (
        <div className="preview">
          <b>{form.id ? "Edit" : "Add"} a network place</b>
          <Row label="Type" hint={form.kind === "smb" ? (smbOk ? "SMB uses the standard smbclient program, which handles SMB 3 signing and encryption. Not yet tested against every NAS, so use Test." : "smbclient is not available in this container, so SMB cannot be used here. Use SFTP.") : "SFTP is the most dependable. Turn on SSH/SFTP on your NAS first."}>
            <select value={form.kind} disabled={Boolean(form.id)} onChange={e => set({ kind: e.target.value as "sftp" | "smb", port: "" })}><option value="sftp">SFTP (over SSH)</option><option value="smb">SMB / Windows share</option></select>
          </Row>
          <Row label="Name"><input value={form.name} placeholder="Office NAS" onChange={e => set({ name: e.target.value })} /></Row>
          <Row label="Server address" hint="A name or IP address, without http:// or slashes."><input value={form.host} placeholder="192.168.1.20" onChange={e => set({ host: e.target.value.trim() })} /></Row>
          <Row label="Port" hint={`Leave empty for ${form.kind === "sftp" ? "22" : "445"}.`}><input inputMode="numeric" value={form.port} onChange={e => set({ port: e.target.value.replace(/\D/g, "") })} /></Row>
          {form.kind === "smb" && <Row label="Share name" hint="The shared folder's name on the NAS."><input value={form.share} placeholder="backups" onChange={e => set({ share: e.target.value })} /></Row>}
          <Row label="Folder" hint="Created if it does not exist. Copies are kept in here."><input value={form.path} placeholder="homebase" onChange={e => set({ path: e.target.value })} /></Row>
          <Row label="User name"><input value={form.username} autoComplete="off" onChange={e => set({ username: e.target.value })} /></Row>
          {form.kind === "smb" && <Row label="Domain (optional)"><input value={form.domain} onChange={e => set({ domain: e.target.value })} /></Row>}
          <Row label="Password" hint={form.id ? "Leave empty to keep the saved password. It is stored encrypted." : "Stored encrypted."}><input type="password" autoComplete="new-password" value={form.password} onChange={e => set({ password: e.target.value })} /></Row>
          <Row label="Keep the newest" hint="Older Homebase copies in that folder are removed after each send. Other files are never touched."><input inputMode="numeric" value={form.keep} onChange={e => set({ keep: e.target.value.replace(/\D/g, "") })} /></Row>
          <Row label=""><label className="check"><input type="checkbox" checked={form.enabled} onChange={e => set({ enabled: e.target.checked })} /> Send scheduled copies here</label></Row>
          {f.el}
          <span className="row wrapme"><button className="btn pri" onClick={() => void saveForm()}>Save</button><button className="btn" onClick={() => { setForm(null); f.clear(); }}>Cancel</button></span>
        </div>
      )}
    </Section>
  );
}
