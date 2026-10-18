import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { IntegrationInfo } from "../types";

export interface OpenTarget { url: string; name: string; mode: "tab" | "inapp" }
/** What a browser should open for a connection: its open address, or else the address Homebase itself uses (only admins can see that one). */
export const addressOf = (i: Pick<IntegrationInfo, "openUrl" | "url">) => i.openUrl || i.url || "";
export const modeOf = (i: Pick<IntegrationInfo, "openMode">): "tab" | "inapp" => (i.openMode === "inapp" ? "inapp" : "tab");
export const openInTab = (url: string) => { window.open(url, "_blank", "noopener,noreferrer"); };

const OpenerContext = createContext<(t: OpenTarget) => void>(t => openInTab(t.url));
export const useOpener = () => useContext(OpenerContext);

/** Opens an address in a new tab, or inside Homebase when asked. Inside Homebase, the app is checked first; if it refuses to be shown in another page the person is told why and offered a new tab. */
export function OpenerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<OpenTarget | null>(null);
  const open = useCallback((t: OpenTarget) => { if (t.mode === "inapp") setTarget(t); else openInTab(t.url); }, []);
  return <OpenerContext.Provider value={open}>{children}{target && <Viewer key={target.url} target={target} onClose={() => setTarget(null)} />}</OpenerContext.Provider>;
}

function Viewer({ target, onClose }: { target: OpenTarget; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<"checking" | "ok" | "blocked">("checking");
  const [reason, setReason] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    void api.get<{ embeddable: boolean; reason: string }>(`/api/frame-check?url=${encodeURIComponent(target.url)}`)
      .then(r => { if (!live) return; setState(r.embeddable ? "ok" : "blocked"); setReason(r.reason); })
      .catch(e => { if (live) { setState("blocked"); setReason(e instanceof Error ? e.message : "Could not check"); } });
    return () => { live = false; };
  }, [target.url]);
  return (
    <dialog ref={ref} className="viewer" onClose={onClose} aria-label={target.name}>
      <div className="viewer-bar">
        <b>{target.name}</b>
        <span className="sub viewer-url">{target.url}</span>
        <span className="row">
          {state === "ok" && <button className="btn sm" onClick={() => setN(n + 1)} title="Reload">↻</button>}
          <button className="btn sm" onClick={() => openInTab(target.url)}>Open in a new tab ↗</button>
          <button className="btn sm" aria-label="Close" onClick={() => ref.current?.close()}>✕</button>
        </span>
      </div>
      {state === "checking" && <div className="viewer-msg">Checking that it can be shown here…</div>}
      {state === "blocked" && (
        <div className="viewer-msg">
          <p><b>{target.name}</b> can't be shown inside Homebase.</p>
          <p className="sub">{reason}</p>
          <button className="btn pri" onClick={() => { openInTab(target.url); ref.current?.close(); }}>Open in a new tab instead</button>
        </div>
      )}
      {state === "ok" && <iframe key={n} title={target.name} src={target.url} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals" />}
    </dialog>
  );
}
