import { useMemo, useState } from "react";
import { api } from "../api";

export interface PickedField { path: string; label: string; unit: string }
interface CatalogField { path: string; group: string; label: string; kind: string; unit: string; value: number | boolean | string }

const UNITS: Array<[string, string]> = [["auto", "Automatic"], ["number", "Number"], ["bytesps", "Bytes per second (as bits)"], ["bps", "Bits per second"], ["bytes", "Bytes (KB, MB, GB)"], ["percent", "Percent"], ["temp", "Temperature °C"], ["duration", "Time span (seconds)"], ["ms", "Milliseconds"], ["mbps", "Mbps"], ["dbm", "Signal dBm"], ["bool", "Yes / no"], ["text", "Text"]];
const MAX = 60;

/** A name that tells fields apart: nested ones (such as wan1 and wan2) get their section in front. */
const nameOf = (f: CatalogField) => { const deeper = f.group.split(" › ").slice(2).join(" "); return (deeper ? `${deeper} ${f.label}` : f.label).slice(0, 60); };
const shown = (v: unknown) => (typeof v === "boolean" ? (v ? "yes" : "no") : String(v).slice(0, 40));

/** Pick any value the console reports. The list is whatever the console answered when asked, so it follows firmware changes. */
export function FieldPicker({ selected, onChange, request, canLoad }: { selected: PickedField[]; onChange: (next: PickedField[]) => void; request: Record<string, unknown>; canLoad: boolean }) {
  const [catalog, setCatalog] = useState<CatalogField[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const chosen = useMemo(() => new Set(selected.map(s => s.path)), [selected]);

  const load = async () => {
    setBusy(true); setError("");
    try { const r = await api.post<{ fields: CatalogField[]; notes: string[] }>("/api/integrations/catalog", request); setCatalog(r.fields); setNotes(r.notes); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not read the list"); }
    setBusy(false);
  };
  const add = (f: CatalogField) => { if (!chosen.has(f.path) && selected.length < MAX) onChange([...selected, { path: f.path, label: nameOf(f), unit: f.unit }]); };
  const edit = (path: string, patch: Partial<PickedField>) => onChange(selected.map(s => (s.path === path ? { ...s, ...patch } : s)));
  const wanRates = () => {
    if (!catalog) return;
    const hits = catalog.filter(f => /\/wan\d+\/(rx|tx)_bytes-r$/.test(f.path) && !chosen.has(f.path));
    onChange([...selected, ...hits.map(f => ({ path: f.path, label: nameOf(f), unit: "bytesps" }))].slice(0, MAX));
  };

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = catalog ? catalog.filter(f => !chosen.has(f.path) && words.every(w => `${f.group} ${f.label} ${f.path}`.toLowerCase().includes(w))) : [];

  return (
    <div className="picker">
      <div className="row sp"><b>Custom stats</b><span className="sub">{selected.length} chosen</span></div>
      <p className="sub">Choose any value the console reports. Turn on the "Custom stats" section in the tile's settings to show them.</p>
      {selected.length > 0 && (
        <div className="rows">
          {selected.map(s => (
            <div key={s.path} className="pick-row">
              <input value={s.label} maxLength={60} onChange={e => edit(s.path, { label: e.target.value })} aria-label="Name shown on the tile" />
              <select value={s.unit} onChange={e => edit(s.path, { unit: e.target.value })} aria-label="How to show the value">{UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              <button type="button" className="btn sm" onClick={() => onChange(selected.filter(x => x.path !== s.path))}>Remove</button>
              <span className="sub trunc pick-path" title={s.path}>{s.path}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <button type="button" className="btn sm" disabled={busy || !canLoad} onClick={load}>{busy ? "Reading…" : catalog ? "Reload list" : "Load the console's fields"}</button>
        {catalog && <button type="button" className="btn sm" onClick={wanRates}>Add per-WAN rates</button>}
        {!canLoad && <span className="sub">Enter the address and key first.</span>}
      </div>
      {error && <p className="error" role="status">✕ {error}</p>}
      {notes.length > 0 && <p className="sub">{notes.join(" · ")}</p>}
      {catalog && (
        <>
          <input type="search" value={q} placeholder={`Search ${catalog.length} fields (for example wan1, temperature, uplink)`} onChange={e => setQ(e.target.value)} aria-label="Search fields" />
          <div className="list pick-list">
            {matches.slice(0, 80).map(f => (
              <div key={f.path} className="li">
                <span className="f1"><span className="trunc">{f.label}</span><span className="sub trunc pick-path">{f.group}</span></span>
                <span className="sub">{shown(f.value)}</span>
                <button type="button" className="btn sm" onClick={() => add(f)} disabled={selected.length >= MAX}>Add</button>
              </div>
            ))}
            {matches.length === 0 && <div className="empty-note">No fields match.</div>}
            {matches.length > 80 && <div className="sub">Showing 80 of {matches.length}. Search to narrow the list.</div>}
          </div>
        </>
      )}
    </div>
  );
}
