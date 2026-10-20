import { useState } from "react";
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
        <Field label="Numbering"><select value={f.topDown ? "top" : "bottom"} onChange={e => setF({ ...f, topDown: e.target.value === "top" })}><option value="bottom">U1 at the bottom</option><option value="top">U1 at the top</option></select></Field>
        <Field label="Notes"><textarea rows={3} value={f.notes} maxLength={2000} onChange={e => setF({ ...f, notes: e.target.value })} placeholder="Location, circuit, key…" /></Field>
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
    ? { name: device.name, kind: device.kind, units: device.units, typed: toTyped(rack, device.slot, device.units), face: device.face, width: device.width, color: device.color, ports: device.ports, watts: device.watts === null ? "" : String(device.watts), integrationId: device.integrationId, notes: device.notes, look: device.look }
    : { name: "", kind: first.id as RackKind, units: first.units, typed: startAt ?? 1, face: "both" as RackFace, width: rack.width as 19 | 10, color: "", ports: first.ports, watts: "", integrationId: "", notes: "", look: "drawn" as "drawn" | "image" });
  const [icon, setIcon] = useState({ icon: device?.icon ?? "", iconRef: device?.iconRef ?? "" });
  const [busy, setBusy] = useState(false);
  const info = kindInfo(f.kind);
  const pick = (kind: RackKind) => { const k = kindInfo(kind); setF({ ...f, kind, ports: k.ports, units: device ? f.units : k.units, name: f.name || (kind === "blank" ? "Blank" : "") }); };
  const save = async () => {
    setBusy(true); n.clear();
    const body = { name: f.name, kind: f.kind, units: f.units, slot: fromTyped(rack, f.typed, f.units), face: f.face, width: f.width, color: f.color, ports: f.ports, watts: f.watts === "" ? null : Number(f.watts), integrationId: f.integrationId, notes: f.notes, look: f.look, icon: icon.icon, iconRef: icon.iconRef };
    try {
      const d = device ? await api.put<RackDeviceInfo>(`/api/racks/devices/${device.id}`, body) : await api.post<RackDeviceInfo>(`/api/racks/${rack.id}/devices`, body);
      onDone(d.id);
    } catch (e) { n.bad(e); }
    setBusy(false);
  };
  const remove = async () => { if (!device) return; try { await api.del(`/api/racks/devices/${device.id}`); onDone(""); } catch (e) { n.bad(e); } };
  return (
    <Modal title={device ? "Edit equipment" : "Add equipment"} eyebrow={rack.name} onClose={onClose} wide>
      <form className="form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <div className="row2">
          <Field label="Name"><input value={f.name} maxLength={60} autoFocus onChange={e => setF({ ...f, name: e.target.value })} placeholder="Core switch" /></Field>
          <Field label="Type"><select value={f.kind} onChange={e => pick(e.target.value as RackKind)}>{KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select></Field>
        </div>
        <div className="row2">
          <Field label="Height (U)"><input type="number" min={1} max={rack.units} value={f.units} onChange={e => setF({ ...f, units: Number(e.target.value) })} /></Field>
          <Field label="Position (U)" hint={`The lowest unit number it covers, on this rack's numbering (U1 is at the ${rack.topDown ? "top" : "bottom"}).`}><input type="number" min={1} max={rack.units} value={f.typed} onChange={e => setF({ ...f, typed: Number(e.target.value) })} /></Field>
        </div>
        <div className="row2">
          <Field label="Mounting" hint="Half-depth equipment on opposite sides can share the same units."><select value={f.face} onChange={e => setF({ ...f, face: e.target.value as RackFace })}>{FACES.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select></Field>
          <Field label="Width" hint={f.width > rack.width ? "Wider than this rack: it will be drawn with a warning." : undefined}><select value={f.width} onChange={e => setF({ ...f, width: Number(e.target.value) === 10 ? 10 : 19 })}><option value={19}>19 inch</option><option value={10}>10 inch</option></select></Field>
        </div>
        <div className="row2">
          {info.unit ? <Field label={`Number of ${info.unit}`}><input type="number" min={0} max={96} value={f.ports} onChange={e => setF({ ...f, ports: Number(e.target.value) })} /></Field> : <span />}
          <Field label="Typical power draw (watts)" hint="Optional. Used for the rack's total when no linked power strip reports live watts."><input type="number" min={0} max={100000} value={f.watts} onChange={e => setF({ ...f, watts: e.target.value })} /></Field>
        </div>
        <Field label="Colour">
          <div className="row g8" role="group" aria-label="Colour">
            <button type="button" className={`rk-sw none ${f.color === "" ? "on" : ""}`} aria-label="No colour" onClick={() => setF({ ...f, color: "" })}>–</button>
            {["1", "2", "3", "4", "5", "6"].map(c => <button key={c} type="button" className={`rk-sw c${c} ${f.color === c ? "on" : ""}`} aria-label={`Colour ${c}`} onClick={() => setF({ ...f, color: c })} />)}
          </div>
        </Field>
        <Field label="Linked connection" hint="Shows whether it is online, and a linked power strip's live watts. Optional."><select value={f.integrationId} onChange={e => setF({ ...f, integrationId: e.target.value })}><option value="">None</option>{integrations.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
        <Field label="Look" hint="Homebase draws the front for you. Your own picture is used for the front view only; the rear is always drawn.">
          <div className="row g8">
            <select value={f.look} onChange={e => setF({ ...f, look: e.target.value as "drawn" | "image" })}><option value="drawn">Drawn by Homebase</option><option value="image">My picture</option></select>
            {f.look === "image" && <><IconButton icon={icon.icon} iconRef={icon.iconRef} name={f.name || "Picture"} size={32} label="Choose a picture" onChange={v => setIcon(v)} /><span className="sub">{icon.icon ? "Picture chosen" : "Choose a picture (upload or an image address)"}</span></>}
          </div>
        </Field>
        <Field label="Notes"><textarea rows={3} value={f.notes} maxLength={2000} onChange={e => setF({ ...f, notes: e.target.value })} placeholder="Serial, asset tag, address, warranty…" /></Field>
        {n.el}
        <div className="acts">
          <span>{device && <Confirm label="Remove" name="Remove this equipment from the rack" sure="Click again to remove" onGo={() => void remove()} />}</span>
          <span className="acts-right"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy || !f.name.trim()}>Save</button></span>
        </div>
      </form>
    </Modal>
  );
}

