import { useEffect, useState } from "react";
import { api } from "../api";
import { Field, Modal } from "./Modal";

/** Same rewrite the server does on save, done here too so the person sees what changed. */
const UNIFI_SECURE = /^rtsps:\/\/((?:[^/\s@]+@)?[^/\s:@]+):7441(\/[^\s?#]+)(?:\?enableSrtp(?:=[^\s&]*)?)?$/i;
const convertUnifi = (v: string) => { const m = UNIFI_SECURE.exec(v.trim()); return m ? `rtsp://${m[1]}:7447${m[2]}` : null; };

export function CameraDialog({ cameraId, onSaved, onRemove, onClose }: { cameraId?: string; onSaved: (id: string, name: string) => void; onRemove?: () => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [main, setMain] = useState("");
  const [sub, setSub] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
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
      <form className="form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="Front door" maxLength={60} autoFocus /></Field>
        <Field label="Main stream (RTSP)" hint="Shown when you open a camera full size."><input value={main} onChange={e => setMain(e.target.value)} onBlur={e => tidy(e.target.value, setMain)} placeholder="rtsp://user:password@192.168.1.20:554/stream1" autoComplete="off" /></Field>
        <Field label="Sub-stream (optional)" hint="A lighter stream for the grid. Leave blank to use the main stream."><input value={sub} onChange={e => setSub(e.target.value)} onBlur={e => tidy(e.target.value, setSub)} placeholder="rtsp://user:password@192.168.1.20:554/stream2" autoComplete="off" /></Field>
        <p className="sub">The password is stored encrypted and never shown to viewers. Paste UniFi Protect links as they are; they are converted for you. Supported addresses start with rtsp://, rtsps://, rtmp://, http:// or https://.</p>
        {note && <p className="sub" role="status">{note}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="acts"><span>{onRemove && <button type="button" className="btn" onClick={onRemove}>Remove camera</button>}</span><span className="acts-right"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy || !main.trim()}>Save</button></span></div>
      </form>
    </Modal>
  );
}
