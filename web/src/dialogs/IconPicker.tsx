import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { TierChooser } from "../settings/Icons";
import { useSettings } from "../settings";
import type { IconChoice, IconHit, IconStatus } from "../types";
import { Field, Modal } from "./Modal";

/** Search the icon libraries, upload an image, or use an https image address. Whatever is chosen is saved on the server first. */
export function IconPicker({ current, currentRef, name, onPick, onClose }: { current?: string | null; currentRef?: string | null; name?: string; onPick: (v: IconChoice) => void | Promise<void>; onClose: () => void }) {
  const { reload } = useSettings();
  const [status, setStatus] = useState<IconStatus | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<IconHit[] | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const loadStatus = useCallback(async () => { try { setStatus(await api.get<IconStatus>("/api/icons/status")); } catch (e) { setError(e instanceof Error ? e.message : "Could not read the icon library"); } }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  const building = status?.reviewed && !status.ready;
  useEffect(() => { if (!building) return; const t = window.setInterval(() => void loadStatus(), 2000); return () => window.clearInterval(t); }, [building, loadStatus]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!status?.ready || query.trim().length < 2) { setHits(null); return; }
    timer.current = window.setTimeout(async () => {
      try { setError(""); setHits(await api.get<IconHit[]>(`/api/icons/search?q=${encodeURIComponent(query.trim())}`)); }
      catch (e) { setHits([]); setError(e instanceof Error ? e.message : "Search failed"); }
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [query, status?.ready]);

  const finish = async (get: () => Promise<IconChoice>, fallback: string) => {
    setBusy(true); setError("");
    try { await onPick(await get()); } catch (e) { setError(e instanceof Error ? e.message : fallback); }
    setBusy(false);
  };
  const upload = (file: File) => finish(async () => { const form = new FormData(); form.append("file", file); return api.post<IconChoice>("/api/icons/upload", form); }, "Could not upload");

  return (
    <Modal title="Choose an icon" eyebrow="Appearance" onClose={onClose} wide>
      <div className="icon-current"><Icon icon={current} iconRef={currentRef} name={name} size={44} />{!current && <span className="sub">Showing letters</span>}</div>
      {status && !status.reviewed ? (
        <>
          <p className="sub">Before searching the libraries, choose how much of them to keep on this server. This is asked once; you can change it later in Settings → Icons.</p>
          <TierChooser value={status.tier} reviewed={false} onDone={() => { void reload(); void loadStatus(); }} />
        </>
      ) : (
        <>
          {building ? (
            <p className="quiet">Building the library… {status!.sources.map(s => `${s.name} ${s.indexed ? "ready" : s.status === "error" ? "failed" : "downloading"}`).join(" · ")}. You can upload or paste an address meanwhile.</p>
          ) : (
            <>
              <Field label="Search icons" hint="Searches Dashboard Icons, selfh.st and Lucide."><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Jellyfin" /></Field>
              <div className="icon-results">
                {hits === null && <p className="quiet">Enter at least two characters to search.</p>}
                {hits?.length === 0 && !error && <p className="quiet">No icons matched.</p>}
                {hits?.map(h => (
                  <button key={h.ref} type="button" className="icon-choice" disabled={busy} title={`${h.label} · ${h.sourceName}`} onClick={() => void finish(() => api.post<IconChoice>("/api/icons/pick", { ref: h.ref }), "Could not save the icon")}>
                    <img className={h.source === "lucide" ? "ic-lucide" : ""} src={h.preview} alt="" loading="lazy" onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} /><span>{h.label}</span><small>{h.sourceName}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          <Field label="Upload your own" hint="PNG, JPEG, GIF, WebP or SVG, up to 2 MB."><input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} /></Field>
          <Field label="Or use an image address"><div className="row"><input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/icon.png" /><button type="button" className="btn" disabled={busy || !url} onClick={() => void finish(() => api.post<IconChoice>("/api/icons/pick", { url }), "Could not save the icon")}>Save</button></div></Field>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="acts"><button type="button" className="btn" disabled={busy} onClick={() => void finish(async () => ({ icon: "", iconRef: "" }), "Could not clear")}>Use letters instead</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
