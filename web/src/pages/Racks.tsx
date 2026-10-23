import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { usePref } from "../hooks";
import { DeviceDialog, RackDialog } from "../racks/Dialogs";
import { RackSvg, exportRack } from "../racks/RackSvg";
import { FACES, kindInfo, liveOf, powerOf, rangeText, usedUnits } from "../racks/model";
import { useNotice } from "../settings/ui";
import type { AuthUser, IntegrationInfo, RackDeviceInfo, RackInfo, Snapshot } from "../types";
import { Pill } from "../widgets/common";

/** The Racks tab: draw your racks to scale, place equipment by dragging or typing a position, and see what is online and how much power it draws. */
export function Racks({ me, integrations, snapshots }: { me: AuthUser; integrations: IntegrationInfo[]; snapshots: Record<string, Snapshot> }) {
  const admin = me.role === "admin";
  const n = useNotice();
  const [racks, setRacks] = useState<RackInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pickedId, setPickedId] = usePref<string>("hb_rack", "");
  const [view, setView] = usePref<"front" | "rear">("hb_rackface", "front");
  const [selected, setSelected] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | { kind: "rack"; edit: boolean } | { kind: "device"; id?: string; at?: number }>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const load = useCallback(async () => {
    try { setRacks((await api.get<{ items: RackInfo[] }>("/api/racks")).items); } catch (e) { n.bad(e); }
    setLoaded(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const rack = racks.find(r => r.id === pickedId) ?? racks[0];
  const device = rack?.devices.find(d => d.id === selected) ?? null;
  const live = (d: RackDeviceInfo) => liveOf(d, integrations, snapshots);
  const power = useMemo(() => (rack ? powerOf(rack, integrations, snapshots) : null), [rack, integrations, snapshots]);

  const move = async (d: RackDeviceInfo, slot: number) => {
    n.clear();
    try { await api.put(`/api/racks/devices/${d.id}`, { slot }); await load(); } catch (e) { n.bad(e); await load(); }
  };
  const doExport = async () => {
    if (!svgRef.current || !rack) return;
    n.clear();
    setSelected(null); // the picture should not carry the selection outline
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    try { await exportRack(svgRef.current!, `${rack.name}-${view}`); } catch (e) { n.bad(e); }
  };

  const used = rack ? usedUnits(rack) : 0;
  const unlinked = (d: RackDeviceInfo) => Boolean(d.integrationId) && !integrations.some(i => i.id === d.integrationId);

  return (
    <div className="rackpage">
      <div className="monhead">
        <div>
          <h2>Racks</h2>
          <p className="sub">{!loaded ? "Loading…" : !racks.length ? "No racks drawn yet." : rack ? `${rack.name} · ${rack.units}U · ${rack.width} inch` : ""}</p>
        </div>
        <div className="row g8 wrapme">
          {rack && <>
            <Pill tone="mute">{used} of {rack.units}U used · {rack.units - used} free</Pill>
            {power && power.watts !== null && <Pill tone={power.source === "live" ? "ok" : "mute"}>{power.watts} W {power.source === "live" ? "live" : "typical"}</Pill>}
            {power && power.offline > 0 && <Pill tone="bad">{power.offline} offline</Pill>}
          </>}
        </div>
      </div>

      <div className="rackbar">
        <div className="rackchips" role="tablist" aria-label="Racks">
          {racks.map(r => <button key={r.id} role="tab" aria-selected={r.id === rack?.id} className={`chip ${r.id === rack?.id ? "on" : ""}`} onClick={() => { setPickedId(r.id); setSelected(null); }}>{r.name}</button>)}
        </div>
        {rack && <div className="row g8 wrapme">
          <div className="seg" role="group" aria-label="Side">
            <button className={view === "front" ? "on" : ""} onClick={() => setView("front")}>Front</button>
            <button className={view === "rear" ? "on" : ""} onClick={() => setView("rear")}>Rear</button>
          </div>
          {admin && <button className="btn" onClick={() => setDlg({ kind: "device" })}>＋ Add equipment</button>}
          <button className="btn" onClick={() => void doExport()}>Export image</button>
          {admin && <RackMenu canEdit onAdd={() => setDlg({ kind: "rack", edit: false })} onEdit={() => setDlg({ kind: "rack", edit: true })} />}
        </div>}
      </div>
      {n.el}

      {loaded && !rack && (
        <div className="empty-note">{admin ? <>Add a rack to start. <button className="btn pri" onClick={() => setDlg({ kind: "rack", edit: false })}>＋ Add a rack</button></> : "An administrator has not drawn any racks yet."}</div>
      )}

      {rack && (
        <div className="rackwrap">
          <div className="rackdraw"><RackSvg rack={rack} view={view} live={live} selectedId={selected} onSelect={setSelected} admin={admin} onMove={(d, s) => void move(d, s)} onAddAt={u => setDlg({ kind: "device", at: u })} svgRef={svgRef} /></div>
          <aside className="rackside">
            {device ? (
              <section className="rkcard">
                <h3>{device.name}</h3>
                <p className="sub">{kindInfo(device.kind).label} · {rangeText(rack, device)} · {device.units}U</p>
                <dl className="rkdl">
                  <dt>Mounting</dt><dd>{FACES.find(f => f.id === device.face)?.label}</dd>
                  <dt>Width</dt><dd>{device.width} inch{device.width > rack.width ? " (wider than this rack)" : ""}</dd>
                  {kindInfo(device.kind).unit && device.ports > 0 && <><dt>{kindInfo(device.kind).unit[0].toUpperCase() + kindInfo(device.kind).unit.slice(1)}</dt><dd>{device.ports}</dd></>}
                  {device.integrationId && <><dt>Connection</dt><dd>{unlinked(device) ? "Removed" : <>{live(device).name} <Pill tone={live(device).state === "up" ? "ok" : live(device).state === "down" ? "bad" : "mute"}>{live(device).state === "up" ? "online" : live(device).state === "down" ? "offline" : "no data"}</Pill></>}</dd></>}
                  {live(device).watts !== null ? <><dt>Power now</dt><dd>{live(device).watts} W</dd></> : device.watts !== null ? <><dt>Typical power</dt><dd>{device.watts} W</dd></> : null}
                </dl>
                {device.notes && <p className="rknotes">{device.notes}</p>}
                {admin && <>
                  <div className="row g8"><button className="btn" onClick={() => setDlg({ kind: "device", id: device.id })}>Edit</button></div>
                </>}
              </section>
            ) : (
              <section className="rkcard"><p className="sub">{admin ? "Click equipment for details. Drag it to move it, or click an empty unit to add something there." : "Click equipment for details."}</p></section>
            )}
            {rack.devices.length > 0 && (
              <section className="rkcard">
                <h3>In this rack</h3>
                <div className="list">
                  {[...rack.devices].sort((a, b) => b.slot - a.slot).map(d => (
                    <button key={d.id} className={`li rkli ${d.id === selected ? "on" : ""}`} onClick={() => setSelected(d.id)}>
                      <span className="trunc">{d.name}</span><span className="sub">{rangeText(rack, d)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {rack.notes && me.role === "admin" && <section className="rkcard"><h3>Notes</h3><p className="rknotes">{rack.notes}</p></section>}
          </aside>
        </div>
      )}

      {dlg?.kind === "rack" && <RackDialog rack={dlg.edit ? rack : undefined} onClose={() => setDlg(null)} onDone={async id => { setDlg(null); await load(); if (id) setPickedId(id); else setPickedId(""); }} />}
      {dlg?.kind === "device" && rack && <DeviceDialog rack={rack} device={dlg.id ? rack.devices.find(d => d.id === dlg.id) : undefined} startAt={dlg.at} integrations={integrations} onClose={() => setDlg(null)} onDone={async id => { setDlg(null); await load(); setSelected(id || null); }} />}
    </div>
  );
}

/** One small menu for the rack itself: add another rack, or change this one. */
function RackMenu({ onAdd, onEdit }: { canEdit?: boolean; onAdd: () => void; onEdit: () => void }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const go = (fn: () => void) => () => { if (ref.current) ref.current.open = false; fn(); };
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener("click", away); return () => document.removeEventListener("click", away);
  }, []);
  return (
    <details className="rkmenu" ref={ref}>
      <summary className="btn" aria-label="Rack options">Rack ▾</summary>
      <div className="rkmenu-list" role="menu">
        <button role="menuitem" onClick={go(onEdit)}>Rack settings…</button>
        <button role="menuitem" onClick={go(onAdd)}>Add another rack…</button>
      </div>
    </details>
  );
}
