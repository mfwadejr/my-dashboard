import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { CameraPlayer, CameraSnapshot } from "../widgets/Camera";

interface ShareInfo { kind: "cameras" | "kiosk"; name: string; expiresAt: number | null; cameras: Array<{ id: string; name: string }> }

/** What someone sees when they open a link you sent them: just the cameras that were shared, nothing else. */
export function ShareView({ token }: { token: string }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [needsPin, setNeedsPin] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"live" | "pictures">("live");
  const [big, setBig] = useState<string | null>(null);

  const open = async (withPin?: string) => {
    setBusy(true); setError("");
    try {
      const r = await api.post<ShareInfo>("/api/share/open", { token, pin: withPin });
      if (r.kind === "kiosk") { window.location.replace("/?kiosk=1"); return; }
      setInfo(r); setNeedsPin(false);
      if (r.cameras.length > 4) setMode("pictures");
    } catch (e) {
      if (e instanceof ApiError && e.body?.needsPin) { setNeedsPin(true); if (withPin) setError(e.message); }
      else setError(e instanceof Error ? e.message : "Could not open this link");
    }
    setBusy(false);
  };
  const started = useRef("");
  useEffect(() => { if (started.current === token) return; started.current = token; void open(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  useEffect(() => { document.title = info ? `${info.name} · cameras` : "Cameras"; }, [info]);

  if (needsPin) {
    return (
      <div className="signin"><form className="signin-card form" onSubmit={e => { e.preventDefault(); void open(pin); }}>
        <div className="logo big"><i />Shared cameras</div>
        <p className="sub">This link is protected. Enter the PIN you were given.</p>
        <label className="field"><span>PIN</span><input autoFocus inputMode="text" autoComplete="off" value={pin} onChange={e => setPin(e.target.value)} maxLength={32} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn pri" disabled={busy || !pin}>Open</button>
      </form></div>
    );
  }
  if (!info) return <div className="boot">{error ? <div className="signin-card"><div className="logo big"><i />Shared cameras</div><p className="error">{error}</p></div> : "Opening…"}</div>;

  const left = info.expiresAt ? Math.max(0, info.expiresAt - Date.now()) : null;
  return (
    <div className="shareview">
      <header className="sharehead">
        <div className="logo"><i />{info.name}</div>
        <span className="sub">{info.cameras.length} camera{info.cameras.length === 1 ? "" : "s"}{left !== null ? ` · link ends in ${left > 86400e3 ? Math.round(left / 86400e3) + " days" : left > 3600e3 ? Math.round(left / 3600e3) + " hours" : Math.max(1, Math.round(left / 60e3)) + " minutes"}` : ""}</span>
        <span className="row ml-auto">
          <button className={`btn sm ${mode === "live" ? "pri" : ""}`} onClick={() => setMode("live")}>Live</button>
          <button className={`btn sm ${mode === "pictures" ? "pri" : ""}`} onClick={() => setMode("pictures")}>Pictures</button>
        </span>
      </header>
      {info.cameras.length === 0 && <p className="sub pad20">The cameras in this link were removed.</p>}
      <div className={`sharegrid n${Math.min(info.cameras.length, 4)}`}>
        {info.cameras.map(c => (
          <figure key={c.id} className="sharecam">
            <div className="shareframe">{mode === "live" ? <CameraPlayer cameraId={c.id} /> : <CameraSnapshot cameraId={c.id} refreshSec={5} />}</div>
            <figcaption><span>{c.name}</span><button className="btn sm" onClick={() => setBig(c.id)}>Enlarge</button></figcaption>
          </figure>
        ))}
      </div>
      {big && (
        <div className="sharebig" onClick={() => setBig(null)}>
          <div className="sharebig-in" onClick={e => e.stopPropagation()}>
            <div className="sharebig-head"><b>{info.cameras.find(c => c.id === big)?.name}</b><button className="btn sm" onClick={() => setBig(null)}>Close</button></div>
            <div className="shareframe"><CameraPlayer cameraId={big} main /></div>
          </div>
        </div>
      )}
    </div>
  );
}
