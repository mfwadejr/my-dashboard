import { useEffect, useRef, useState } from "react";
import { api, iconUrl } from "../api";
import type { IconHit } from "../types";
import { Field, Modal } from "./Modal";

/** Search the Dashboard Icons library, upload an image, or paste an https image address. The chosen image is stored on the server. */
export function IconPicker({ current, onPick, onClose }: { current?: string | null; onPick: (id: string | null) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<IconHit[] | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    setError("");
    if (query.trim().length < 2) { setHits(null); return; }
    timer.current = window.setTimeout(async () => {
      try { setHits(await api.get<IconHit[]>(`/api/icons/search?q=${encodeURIComponent(query.trim())}`)); }
      catch (e) { setHits([]); setError(e instanceof Error ? e.message : "Search failed"); }
    }, 280);
    return () => window.clearTimeout(timer.current);
  }, [query]);

  const pick = async (body: { ref?: string; url?: string }) => {
    setBusy(true); setError("");
    try { const { id } = await api.post<{ id: string }>("/api/icons/pick", body); onPick(id); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save the icon"); }
    setBusy(false);
  };
  const upload = async (file: File) => {
    setBusy(true); setError("");
    try { const form = new FormData(); form.append("file", file); const { id } = await api.post<{ id: string }>("/api/icons/upload", form); onPick(id); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not upload"); }
    setBusy(false);
  };

  return (
    <Modal title="Choose an icon" eyebrow="Appearance" onClose={onClose} wide>
      <div className="icon-current">{current ? <img src={iconUrl(current)} alt="" /> : <span className="sub">Using the letter fallback</span>}</div>
      <Field label="Search icons" hint="Searches the Dashboard Icons library (the same one Homarr uses). The icon you pick is saved on your server."><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Jellyfin" /></Field>
      <div className="icon-results">
        {hits === null && <p className="quiet">Enter at least two characters to search.</p>}
        {hits?.length === 0 && !error && <p className="quiet">No icons matched.</p>}
        {hits?.map(h => (
          <button key={h.ref} type="button" className="icon-choice" disabled={busy} onClick={() => void pick({ ref: h.ref })}>
            <img src={h.preview} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} /><span>{h.label}</span>
          </button>
        ))}
      </div>
      <Field label="Upload your own" hint="PNG, JPEG, GIF, WebP or SVG, up to 2 MB."><input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} /></Field>
      <Field label="Or use an image address"><div className="row"><input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/icon.png" /><button type="button" className="btn" disabled={busy || !url} onClick={() => void pick({ url })}>Save</button></div></Field>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="acts"><button type="button" className="btn" onClick={() => onPick(null)}>Use letters instead</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
