import { useEffect, useState } from "react";
import { api } from "../api";
import type { IntegrationInfo } from "../types";
import { Field, Modal } from "./Modal";

/** Same rewrite the server does on save, done here too so the person sees what changed. */
const UNIFI_SECURE = /^rtsps:\/\/((?:[^/\s@]+@)?[^/\s:@]+):7441(\/[^\s?#]+)(?:\?enableSrtp(?:=[^\s&]*)?)?$/i;
const convertUnifi = (v: string) => { const m = UNIFI_SECURE.exec(v.trim()); return m ? `rtsp://${m[1]}:7447${m[2]}` : null; };

interface TestResult { which: string; ok: boolean; message: string; image?: string }
interface Found { id: string; name: string; state: string }

/** Lists the cameras on a UniFi Protect connection and imports the ones you tick, with their stream addresses filled in. */
function ProtectImport({ protect, onImported }: { protect: IntegrationInfo[]; onImported: (ids: string[]) => void }) {
  const [pid, setPid] = useState(protect[0]?.id ?? "");
  const [found, setFound] = useState<Found[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const find = async () => {
    setBusy(true); setMsg(""); setFound(null);
    try { const list = await api.get<Found[]>(`/api/protect/${pid}/cameras`); setFound(list); setPicked(list.filter(c => c.state.toUpperCase() === "CONNECTED").map(c => c.id)); setMsg(list.length ? `Found ${list.length} camera${list.length === 1 ? "" : "s"}.` : "Protect answered, but it lists no cameras."); }
    catch (e) { setMsg(e instanceof Error ? e.message : "Could not list cameras"); }
    setBusy(false);
  };
  const run = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await api.post<{ created: Array<{ id: string }>; skipped: Array<{ name: string; reason: string }> }>(`/api/protect/${pid}/import`, { ids: picked });
      if (r.created.length) { onImported(r.created.map(c => c.id)); return; }
      setMsg(r.skipped.map(s => `${s.name}: ${s.reason}`).join(" · ") || "Nothing was imported.");
    } catch (e) { setMsg(e instanceof Error ? e.message : "Import failed"); }
    setBusy(false);
  };
  return (
    <div className="field"><span>Or import from UniFi Protect</span>
      <div className="row">
        {protect.length > 1 && <select value={pid} onChange={e => { setPid(e.target.value); setFound(null); }}>{protect.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <button type="button" className="btn sm" disabled={busy} onClick={() => void find()}>{found ? "Refresh list" : `Find cameras on ${protect.length === 1 ? protect[0].name : "this console"}`}</button>
      </div>
      {found && found.length > 0 && (
        <>
          <div className="row g8">
            <button type="button" className="btn sm" disabled={picked.length === found.length} onClick={() => setPicked(found.map(c => c.id))}>Select all</button>
            <button type="button" className="btn sm" disabled={picked.length === 0} onClick={() => setPicked([])}>Select none</button>
            <span className="sub">{picked.length} of {found.length} selected</span>
          </div>
          <div className="list sec-pick">{found.map(c => (
            <div key={c.id} className="li"><label className="chk"><input type="checkbox" checked={picked.includes(c.id)} onChange={e => setPicked(e.target.checked ? [...picked, c.id] : picked.filter(x => x !== c.id))} /> {c.name}</label><span className="sub">{c.state.toLowerCase()}</span></div>
          ))}</div>
          <button type="button" className="btn sm pri" disabled={busy || picked.length === 0} onClick={() => void run()}>Import {picked.length} camera{picked.length === 1 ? "" : "s"}</button>
        </>
      )}
      {msg && <small role="status">{msg}</small>}
      <small>Homebase asks Protect for each camera's stream address, converts it, and keeps it encrypted. Cameras already added are skipped.</small>
    </div>
  );
}

export function CameraDialog({ cameraId, integrations = [], onSaved, onImported, onRemove, onClose }: { cameraId?: string; integrations?: IntegrationInfo[]; onSaved: (id: string, name: string) => void; onImported?: (ids: string[]) => void; onRemove?: () => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [main, setMain] = useState("");
  const [sub, setSub] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [tests, setTests] = useState<TestResult[] | null>(null);
  const [testing, setTesting] = useState(false);
  const protect = integrations.filter(i => i.type === "unifi-protect");
  const runTest = async () => {
    setTesting(true); setTests(null); setError("");
    try { setTests((await api.post<{ results: TestResult[] }>("/api/cameras/test", { cameraId, main: main.trim(), sub: sub.trim() })).results); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not run the test"); }
    setTesting(false);
  };
  const tidy = (v: string, set: (x: string) => void) => { const c = convertUnifi(v); if (c) { set(c); setNote("UniFi's secure link was changed to the plain RTSP address (port 7447), which the camera relay can play."); } };
  const [relay, setRelay] = useState<{ enabled: boolean; reachable: boolean } | null>(null);
  useEffect(() => { void api.get<{ enabled: boolean; reachable: boolean }>("/api/go2rtc/status").then(setRelay).catch(() => setRelay(null)); }, []);
  useEffect(() => {
    if (!cameraId) return;
    void api.get<{ name: string; main: string; sub: string }>(`/api/cameras/${cameraId}`).then(c => { setName(c.name); setMain(c.main); setSub(c.sub); }).catch(e => setError(e.message));
  }, [cameraId]);

  const save = async () => {
    setBusy(true); setError("");
    try {
      const body = { name: name.trim() || "Camera", main: main.trim(), sub: sub.trim() };
      if (cameraId) { await api.put(`/api/cameras/${cameraId}`, body); onSaved(cameraId, body.name); }
      else { const { id } = await api.post<{ id: string }>("/api/cameras", body); onSaved(id, body.name); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); }
    setBusy(false);
  };
  return (
    <Modal title={cameraId ? "Camera settings" : "Add a camera"} eyebrow="Camera" onClose={onClose}>
      {relay && !relay.enabled && <p className="error">The camera relay (go2rtc) is not configured. Set GO2RTC_URL, or use the compose file that includes it.</p>}
      {relay?.enabled && !relay.reachable && <p className="error">Homebase cannot reach go2rtc right now. You can still save the camera; it will connect once go2rtc is up.</p>}
      {!cameraId && protect.length > 0 && onImported && <div className="form"><ProtectImport protect={protect} onImported={onImported} /></div>}
      <form className="form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="Front door" maxLength={60} autoFocus /></Field>
        <Field label="Main stream (RTSP)" hint="Shown when you open a camera full size."><input value={main} onChange={e => setMain(e.target.value)} onBlur={e => tidy(e.target.value, setMain)} placeholder="rtsp://user:password@192.168.1.20:554/stream1" autoComplete="off" /></Field>
        <Field label="Sub-stream (optional)" hint="A lighter stream for the grid. Leave blank to use the main stream."><input value={sub} onChange={e => setSub(e.target.value)} onBlur={e => tidy(e.target.value, setSub)} placeholder="rtsp://user:password@192.168.1.20:554/stream2" autoComplete="off" /></Field>
        <p className="sub">The password is stored encrypted and never shown to viewers. Paste UniFi Protect links as they are; they are converted for you. Supported addresses start with rtsp://, rtsps://, rtmp://, http:// or https://.</p>
        {note && <p className="sub" role="status">{note}</p>}
        {tests && (
          <div className="cam-test" role="status">
            {tests.map(t => (
              <div key={t.which}>
                <div className={t.ok ? "ok" : "bad"}>{t.which === "main" ? "Main stream" : "Sub-stream"}: {t.message}</div>
                {t.image && <img src={t.image} alt={`${t.which} stream preview`} />}
              </div>
            ))}
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="acts"><span>{onRemove && <button type="button" className="btn" onClick={onRemove}>Remove camera</button>}</span><span className="acts-right"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn" disabled={testing || !main.trim()} onClick={() => void runTest()}>{testing ? "Testing…" : "Test"}</button><button className="btn pri" disabled={busy || !main.trim()}>Save</button></span></div>
      </form>
    </Modal>
  );
}
