import { useEffect, useState } from "react";
import { api } from "../api";
import { IconButton } from "../components/IconButton";
import { Field, Modal } from "../dialogs/Modal";
import type { IntegrationInfo, RackDeviceInfo, RackFace, RackInfo, RackKind } from "../types";
import { useNotice } from "../settings/ui";
import { Confirm } from "../widgets/common";
import { FACES, KINDS, fromTyped, kindInfo, toTyped } from "./model";

const HEIGHTS = [6, 9, 12, 18, 22, 24, 27, 42, 45, 48];

export function RackDialog({ rack, onDone, onClose }: { rack?: RackInfo; onDone: (id?: string) => void; onClose: () => void }) {
  const n = useNotice();
  const [f, setF] = useState({ name: rack?.name ?? "", units: rack?.units ?? 42, width: rack?.width ?? 19, topDown: rack?.topDown ?? false, notes: rack?.notes ?? "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); n.clear();
    try {
      const r = rack ? await api.put<RackInfo>(`/api/racks/${rack.id}`, f) : await api.post<RackInfo>("/api/racks", f);
      onDone(r.id);
    } catch (e) { n.bad(e); }
    setBusy(false);
  };
  const remove = async () => { if (!rack) return; try { await api.del(`/api/racks/${rack.id}`); onDone(); } catch (e) { n.bad(e); } };
  return (
    <Modal title={rack ? "Rack settings" : "Add a rack"} eyebrow="Racks" onClose={onClose}>
      <form className="form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <Field label="Name"><input value={f.name} maxLength={60} autoFocus onChange={e => setF({ ...f, name: e.target.value })} placeholder="Main rack" /></Field>
        <div className="row2">
          <Field label="Height (U)" hint="From 1 to 60. A full-size rack is usually 42."><input type="number" min={1} max={60} value={f.units} onChange={e => setF({ ...f, units: Number(e.target.value) })} list="rack-heights" /></Field>
          <Field label="Width"><select value={f.width} onChange={e => setF({ ...f, width: Number(e.target.value) === 10 ? 10 : 19 })}><option value={19}>19 inch</option><option value={10}>10 inch</option></select></Field>
        </div>
        <datalist id="rack-heights">{HEIGHTS.map(h => <option key={h} value={h} />)}</datalist>
        <details className="more"><summary>More options</summary>
        <Field label="Numbering"><select value={f.topDown ? "top" : "bottom"} onChange={e => setF({ ...f, topDown: e.target.value === "top" })}><option value="bottom">U1 at the bottom</option><option value="top">U1 at the top</option></select></Field>
        <Field label="Notes"><textarea rows={3} value={f.notes} maxLength={2000} onChange={e => setF({ ...f, notes: e.target.value })} placeholder="Location, circuit, key…" /></Field>
        </details>
        {n.el}
        <div className="acts">
          <span>{rack && <Confirm label="Delete rack" name="Delete this rack and everything in it" sure="Click again to delete" onGo={() => void remove()} />}</span>
          <span className="acts-right"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy || !f.name.trim()}>Save</button></span>
        </div>
      </form>
    </Modal>
  );
}

export function DeviceDialog({ rack, device, startAt, integrations, onDone, onClose }: {
  rack: RackInfo; device?: RackDeviceInfo; startAt?: number; integrations: IntegrationInfo[]; onDone: (id: string) => void; onClose: () => void;
}) {
  const n = useNotice();
  const first = KINDS[0];
  const [f, setF] = useState(() => device
    ? { name: device.name, kind: device.kind, units: device.units, typed: toTyped(rack, device.slot, device.units), face: device.face, width: device.width, color: device.color, ports: device.ports, watts: device.watts === null ? "" : String(device.watts), integrationId: device.integrationId, notes: device.notes, fit: device.fit }
    : { name: "", kind: first.id as RackKind, units: first.units, typed: startAt ?? 1, face: "both" as RackFace, width: rack.width as 19 | 10, color: "", ports: first.ports, watts: "", integrationId: "", notes: "", fit: "stretch" as "stretch" | "fit" | "fill" });
  const [icon, setIcon] = useState({ icon: device?.icon ?? "", iconRef: device?.iconRef ?? "" });
  const [rear, setRear] = useState({ icon: device?.rearIcon ?? "", iconRef: device?.rearIconRef ?? "" });
  const [finder, setFinder] = useState(false);
  // A new piece of equipment starts by choosing how to begin: from a library picture, or blank.
  const [started, setStarted] = useState(Boolean(device));
  const [busy, setBusy] = useState(false);
  const info = kindInfo(f.kind);
  const hasPicture = Boolean(icon.icon || rear.icon);
  const pick = (kind: RackKind) => { const k = kindInfo(kind); setF({ ...f, kind, ports: k.ports, units: device ? f.units : k.units, name: f.name || (kind === "blank" ? "Blank" : "") }); };
  const save = async () => {
    setBusy(true); n.clear();
    const body = { name: f.name, kind: f.kind, units: f.units, slot: fromTyped(rack, f.typed, f.units), face: f.face, width: f.width, color: f.color, ports: f.ports, watts: f.watts === "" ? null : Number(f.watts), integrationId: f.integrationId, notes: f.notes, look: hasPicture ? "image" : "drawn", fit: f.fit, icon: icon.icon, iconRef: icon.iconRef, rearIcon: rear.icon, rearIconRef: rear.iconRef };
    try {
      const d = device ? await api.put<RackDeviceInfo>(`/api/racks/devices/${device.id}`, body) : await api.post<RackDeviceInfo>(`/api/racks/${rack.id}/devices`, body);
      onDone(d.id);
    } catch (e) { n.bad(e); }
    setBusy(false);
  };
  const remove = async () => { if (!device) return; try { await api.del(`/api/racks/devices/${device.id}`); onDone(""); } catch (e) { n.bad(e); } };
  const picked = (r: Imported) => {
    setFinder(false); setStarted(true);
    setIcon(r.front ?? { icon: "", iconRef: "" }); setRear(r.rear ?? { icon: "", iconRef: "" });
    const kind: RackKind = (r.ports ?? 0) >= 8 ? "switch" : f.kind;
    setF({ ...f, name: f.name || r.name, units: r.units ? Math.max(1, Math.min(rack.units, r.units)) : f.units, face: r.fullDepth === false ? "front" : f.face, kind, ports: r.ports || f.ports });
  };
  if (!started) {
    return (
      <Modal title="Add equipment" eyebrow={rack.name} onClose={onClose}>
        <div className="form">
          <p className="sub">How would you like to start?</p>
          <div className="rk-start">
            <button type="button" className="btn pri" onClick={() => setFinder(true)}>Find in the device library</button>
            <button type="button" className="btn" onClick={() => setStarted(true)}>Start blank</button>
          </div>
        </div>
        {finder && <LibraryDialog onClose={() => setFinder(false)} onPick={picked} />}
      </Modal>
    );
  }
  return (
    <Modal title={device ? "Edit equipment" : "Add equipment"} eyebrow={rack.name} onClose={onClose} wide>
      <form className="form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <div className="row2">
          <Field label="Name"><input value={f.name} maxLength={60} autoFocus onChange={e => setF({ ...f, name: e.target.value })} placeholder="Core switch" /></Field>
          <Field label="Type"><select value={f.kind} onChange={e => pick(e.target.value as RackKind)}>{KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select></Field>
        </div>
        <div className="row2">
          <Field label="Height (U)"><input type="number" min={1} max={rack.units} value={f.units} onChange={e => setF({ ...f, units: Number(e.target.value) })} /></Field>
          <Field label="Position (U)" hint={`The lowest unit it covers (U1 is at the ${rack.topDown ? "top" : "bottom"}).`}><input type="number" min={1} max={rack.units} value={f.typed} onChange={e => setF({ ...f, typed: Number(e.target.value) })} /></Field>
        </div>
        <Field label="Picture" hint={hasPicture ? undefined : "Optional. Without one, Homebase draws the equipment for you."}>
          <div className="row g8 wrapme">
            <IconButton icon={icon.icon} iconRef={icon.iconRef} name={f.name || "Picture"} size={32} label="Upload or choose the front picture" onChange={v => setIcon(v)} />
            <button type="button" className="btn" onClick={() => setFinder(true)}>Find in library…</button>
            {hasPicture && <button type="button" className="btn" onClick={() => { setIcon({ icon: "", iconRef: "" }); setRear({ icon: "", iconRef: "" }); }}>Remove picture</button>}
          </div>
        </Field>
        {integrations.length > 0 && <Field label="Linked connection" hint="Shows whether it is online, and a linked power strip's live watts."><select value={f.integrationId} onChange={e => setF({ ...f, integrationId: e.target.value })}><option value="">None</option>{integrations.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>}
        <details className="more"><summary>More options</summary>
          <div className="row2">
            <Field label="Mounting" hint="Half-depth equipment on opposite sides can share the same units."><select value={f.face} onChange={e => setF({ ...f, face: e.target.value as RackFace })}>{FACES.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select></Field>
            <Field label="Width" hint={f.width > rack.width ? "Wider than this rack: it will be drawn with a warning." : undefined}><select value={f.width} onChange={e => setF({ ...f, width: Number(e.target.value) === 10 ? 10 : 19 })}><option value={19}>19 inch</option><option value={10}>10 inch</option></select></Field>
          </div>
          <div className="row2">
            {info.unit && !hasPicture ? <Field label={`Number of ${info.unit}`}><input type="number" min={0} max={96} value={f.ports} onChange={e => setF({ ...f, ports: Number(e.target.value) })} /></Field> : <span />}
            <Field label="Typical power draw (watts)" hint="Used for the rack total when no linked power strip reports live watts."><input type="number" min={0} max={100000} value={f.watts} onChange={e => setF({ ...f, watts: e.target.value })} /></Field>
          </div>
          <Field label="Colour">
            <div className="row g8" role="group" aria-label="Colour">
              <button type="button" className={`rk-sw none ${f.color === "" ? "on" : ""}`} aria-label="No colour" onClick={() => setF({ ...f, color: "" })}>–</button>
              {["1", "2", "3", "4", "5", "6"].map(c => <button key={c} type="button" className={`rk-sw c${c} ${f.color === c ? "on" : ""}`} aria-label={`Colour ${c}`} onClick={() => setF({ ...f, color: c })} />)}
            </div>
          </Field>
          {hasPicture && <>
            <div className="row2">
              <Field label="Rear picture"><div className="row g8"><IconButton icon={rear.icon} iconRef={rear.iconRef} name={f.name || "Rear"} size={32} label="Upload or choose the rear picture" onChange={v => setRear(v)} /><span className="sub">{rear.icon ? "Chosen" : "Optional. The rear is drawn without one"}</span></div></Field>
              <Field label="Picture fit" hint="Stretch fills the slot. Fit keeps the picture's shape. Fill crops the edges."><select value={f.fit} onChange={e => setF({ ...f, fit: e.target.value as "stretch" | "fit" | "fill" })}><option value="stretch">Stretch</option><option value="fit">Fit</option><option value="fill">Fill</option></select></Field>
            </div>
          </>}
          <Field label="Notes"><textarea rows={3} value={f.notes} maxLength={2000} onChange={e => setF({ ...f, notes: e.target.value })} placeholder="Serial, asset tag, address, warranty…" /></Field>
        </details>
        {n.el}
        {finder && <LibraryDialog onClose={() => setFinder(false)} onPick={picked} />}
        <div className="acts">
          <span>{device && <Confirm label="Remove" name="Remove this equipment from the rack" sure="Click again to remove" onGo={() => void remove()} />}</span>
          <span className="acts-right"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy || !f.name.trim()}>Save</button></span>
        </div>
      </form>
    </Modal>
  );
}

interface Imported { name: string; units: number | null; fullDepth: boolean | null; ports: number | null; front: { icon: string; iconRef: string } | null; rear: { icon: string; iconRef: string } | null }

/** Browses the NetBox community device library (fetched by this server) and saves the chosen model's pictures as the user's own copies. */
function LibraryDialog({ onPick, onClose }: { onPick: (r: Imported) => void; onClose: () => void }) {
  const n = useNotice();
  const [source, setSource] = useState<"drawio" | "netbox">("drawio");
  const [mfrs, setMfrs] = useState<string[]>([]);
  const [mfr, setMfr] = useState("Unifi");
  const [q, setQ] = useState("");
  const [models, setModels] = useState<Array<{ id: string; label: string }> | null>(null);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    setMfrs([]); setModels(null); n.clear();
    api.get<{ items: string[] }>(`/api/racks/library/manufacturers?source=${source}`).then(r => {
      setMfrs(r.items);
      const want = source === "drawio" ? "Unifi" : "Ubiquiti";
      setMfr(r.items.find(m => m.toLowerCase() === want.toLowerCase()) ?? r.items[0] ?? "");
    }).catch(e => { n.bad(e); setModels([]); });
  }, [source]);
  useEffect(() => {
    if (!mfr) return;
    setModels(null); n.clear();
    const t = setTimeout(() => { api.get<{ items: Array<{ id: string; label: string }> }>(`/api/racks/library/models?source=${source}&manufacturer=${encodeURIComponent(mfr)}&q=${encodeURIComponent(q)}`).then(r => setModels(r.items)).catch(e => { n.bad(e); setModels([]); }); }, 250);
    return () => clearTimeout(t);
  }, [mfr, q, source]);
  const choose = async (model: string) => {
    setBusy(model); n.clear();
    try { onPick(await api.post<Imported>("/api/racks/library/import", { source, manufacturer: mfr, model })); } catch (e) { n.bad(e); }
    setBusy("");
  };
  return (
    <Modal title="Device library" eyebrow="Community pictures" onClose={onClose} wide>
      <div className="form">
        <p className="sub">Searches a community picture library on the internet. The picture you choose is saved on your server as your own copy. Check the library's terms if you share your dashboard publicly.</p>
        <Field label="Library"><select value={source} onChange={e => setSource(e.target.value as "drawio" | "netbox")}><option value="drawio">UniFi drawings (draw.io, community)</option><option value="netbox">NetBox device library (many brands)</option></select></Field>
        <div className="row2">
          <Field label="Manufacturer"><select value={mfr} onChange={e => setMfr(e.target.value)}>{(mfrs.length ? mfrs : [mfr]).map(m => <option key={m} value={m}>{m}</option>)}</select></Field>
          <Field label="Search"><input value={q} autoFocus onChange={e => setQ(e.target.value)} placeholder="USW Pro 24, UDM, Dream Machine…" /></Field>
        </div>
        {n.el}
        <div className="libmodels" role="list">
          {models === null && <p className="sub">Searching…</p>}
          {models?.length === 0 && <p className="sub">No models with pictures found.</p>}
          {models?.map(m => <button key={m.id} type="button" role="listitem" className="btn libmodel" disabled={!!busy} onClick={() => void choose(m.id)}>{busy === m.id ? "Saving…" : m.label}</button>)}
        </div>
        <div className="acts"><span /><span className="acts-right"><button type="button" className="btn" onClick={onClose}>Close</button></span></div>
      </div>
    </Modal>
  );
}
