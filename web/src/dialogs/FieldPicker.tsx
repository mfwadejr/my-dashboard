import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api";

export interface PickedField { path: string; label: string; unit: string }
interface CatalogField { path: string; group: string; label: string; kind: string; unit: string; value: number | boolean | string }

const UNITS: Array<[string, string]> = [["auto", "Automatic"], ["number", "Number"], ["bytesps", "Bytes per second (as bits)"], ["bps", "Bits per second"], ["bytes", "Bytes (KB, MB, GB)"], ["percent", "Percent"], ["temp", "Temperature °C"], ["duration", "Time span (seconds)"], ["ms", "Milliseconds"], ["mbps", "Mbps"], ["dbm", "Signal dBm"], ["bool", "Yes / no"], ["text", "Text"]];
const MAX = 60;
interface Node { name: string; kids: Map<string, Node>; fields: CatalogField[]; total: number; chosen: number }

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
  const searching = words.length > 0;
  const tree = useMemo(() => {
    if (!catalog) return [];
    const roots = new Map<string, Node>();
    for (const f of catalog) {
      const segs = f.group.split(" › ");
      const top = segs.length > 1 ? segs.slice(0, 2).join(" › ") : segs[0];
      const rest = segs.length > 1 ? segs.slice(2) : [];
      let node: Node = roots.get(top) ?? { name: top, kids: new Map(), fields: [], total: 0, chosen: 0 };
      roots.set(top, node);
      const path = [node];
      for (const part of rest) { const kid: Node = node.kids.get(part) ?? { name: part, kids: new Map(), fields: [], total: 0, chosen: 0 }; node.kids.set(part, kid); node = kid; path.push(node); }
      if (chosen.has(f.path)) { for (const n of path) n.chosen++; continue; }
      if (searching && !words.every(w => `${f.group} ${f.label} ${f.path}`.toLowerCase().includes(w))) continue;
      node.fields.push(f);
      for (const n of path) n.total++;
    }
    return [...roots.values()].filter(n => n.total > 0 || (!searching && n.chosen > 0));
  }, [catalog, chosen, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleAll = (name: string) => setExpanded(prev => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });

  const leaves = (n: Node) => (
    <>
      {n.fields.slice(0, 200).map(f => (
        <div key={f.path} className="li">
          <span className="f1"><span className="trunc">{f.label}</span></span>
          <span className="sub">{shown(f.value)}</span>
          <button type="button" className="btn sm" onClick={() => add(f)} disabled={selected.length >= MAX}>Add</button>
        </div>
      ))}
      {n.fields.length > 200 && <div className="sub">Showing 200 of {n.fields.length}. Search to narrow the list.</div>}
    </>
  );
  const branch = (n: Node, force: boolean, depth: number): ReactNode => (
    <details key={`${n.name}${force}`} className={`tnode d${Math.min(depth, 2)}`} open={force || undefined}>
      <summary><span className="trunc">{n.name}</span><span className="sub">{n.total} field{n.total === 1 ? "" : "s"}{n.chosen > 0 ? ` · ${n.chosen} chosen` : ""}</span></summary>
      <div className="tbody">
        {depth === 0 && !searching && n.total > 12 && <button type="button" className="btn sm tall" onClick={() => toggleAll(n.name)}>{expanded.has(n.name) ? "Collapse all" : "Expand all"}</button>}
        {leaves(n)}
        {[...n.kids.values()].filter(k => k.total > 0 || (!searching && k.chosen > 0)).map(k => branch(k, force, depth + 1))}
      </div>
    </details>
  );

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
          <div className="tree pick-list">
            {tree.map(n => branch(n, searching || expanded.has(n.name), 0))}
            {tree.length === 0 && <div className="empty-note">No fields match.</div>}
          </div>
        </>
      )}
    </div>
  );
}
