import { useState } from "react";
import { uid } from "../api";
import type { CameraInfo, IntegrationInfo, Tile } from "../types";
import { REFRESH_CHOICES, refreshOf } from "../widgets/Camera";
import type { LauncherItem } from "../widgets/Launcher";
import { WIDGET_BY_TYPE } from "../widgets";
import { Field, Modal } from "./Modal";
import { IconButton } from "../components/IconButton";
import { initials } from "../widgets/common";
import { SECTION_DEFS, resolveSections } from "../widgets/sections";

export function TileSettings({ tile, integrations, cameras = [], onAddCameras, onChange, onOpenConnections, onClose }: {
  tile: Tile; integrations: IntegrationInfo[]; cameras?: CameraInfo[]; onAddCameras?: () => void; onChange: (patch: Record<string, unknown>) => void;
  onOpenConnections: () => void; onClose: () => void;
}) {
  const def = WIDGET_BY_TYPE[tile.type];
  const [items, setItems] = useState<LauncherItem[]>((tile.config.items ?? []) as LauncherItem[]);
  const options = integrations.filter(i => [def?.needs].flat().includes(i.type));
  const saveItems = (next: LauncherItem[]) => { setItems(next); onChange({ items: next }); };
  const patchItem = (id: string, patch: Partial<LauncherItem>) => saveItems(items.map(i => (i.id === id ? { ...i, ...patch } : i)));

  return (
    <Modal title={`${def?.label ?? "Tile"} settings`} eyebrow="Tile" onClose={onClose} wide={tile.type === "launcher"}>
      <div className="form">
        <div className="row2 title-row"><Field label="Title (optional)"><input defaultValue={String(tile.config.title ?? "")} onChange={e => onChange({ title: e.target.value })} maxLength={40} /></Field><div className="field"><span>Icon</span><IconButton icon={tile.config.icon as string | undefined} iconRef={tile.config.iconRef as string | undefined} name={String(tile.config.title || def?.label || "Tile")} label="Choose a tile icon" onChange={v => onChange({ icon: v.icon || undefined, iconRef: v.iconRef || undefined })} /></div></div>
        {def?.needs && (
          <Field label="Connection" hint="Which connected app this tile shows.">
            {options.length ? (
              <select value={String(tile.config.integrationId ?? "")} onChange={e => onChange({ integrationId: e.target.value })}>
                <option value="">Choose…</option>{options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            ) : <div className="row"><span className="sub">No {def.label} connection yet.</span><button className="btn sm" onClick={onOpenConnections}>Add one</button></div>}
          </Field>
        )}
        {tile.type === "camerawall" && (() => {
          const chosen = (tile.config.cameraIds ?? []) as string[];
          const mode = String(tile.config.mode ?? "snapshot");
          const toggle = (id: string, on: boolean) => onChange({ cameraIds: on ? [...chosen, id] : chosen.filter(x => x !== id) });
          const move = (i: number, d: number) => { const n = [...chosen]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; onChange({ cameraIds: n }); };
          const live = chosen.filter(id => cameras.some(c => c.id === id));
          return (
            <>
              <div className="field"><span>Cameras</span>
                {cameras.length ? (
                  <div className="list sec-pick">{cameras.map(c => { const i = live.indexOf(c.id); return (
                    <div key={c.id} className="li"><label className="chk"><input type="checkbox" checked={i >= 0} onChange={e => toggle(c.id, e.target.checked)} /> {c.name}</label>
                      <span className="row" style={{ gap: 4 }}>
                        <button type="button" className="btn sm" aria-label="Move up" disabled={i <= 0} onClick={() => move(chosen.indexOf(c.id), -1)}>↑</button>
                        <button type="button" className="btn sm" aria-label="Move down" disabled={i < 0 || i === live.length - 1} onClick={() => move(chosen.indexOf(c.id), 1)}>↓</button>
                      </span></div>
                  ); })}</div>
                ) : <span className="sub">No cameras yet.</span>}
                {onAddCameras && <button type="button" className="btn sm" onClick={onAddCameras}>＋ Add or import cameras</button>}
                <small>Tick the cameras to show and use the arrows to set the order. Click a camera on the wall to open it full size.</small></div>
              <Field label="Show as" hint="Snapshots are pictures refreshed every few seconds. Live video for many cameras at once is heavy on the network and the browser.">
                <select value={mode} onChange={e => onChange({ mode: e.target.value })}><option value="snapshot">Snapshots, refreshed</option><option value="live">Live video</option></select>
              </Field>
              <Field label="Quality" hint="Full resolution uses each camera's main stream. With many cameras on one wall that is heavy; the picture opened full size always uses the main stream."><select value={tile.config.stream === "main" ? "main" : "sub"} onChange={e => onChange({ stream: e.target.value })}><option value="sub">Light (sub-stream)</option><option value="main">Full resolution (main stream)</option></select></Field>
              {mode === "snapshot" && <Field label="Refresh every"><select value={String(refreshOf(tile.config.refresh))} onChange={e => onChange({ refresh: Number(e.target.value) })}>{REFRESH_CHOICES.map(n => <option key={n} value={n}>{n} seconds</option>)}</select></Field>}
              {mode === "live" && live.length > 4 && <p className="sub">That is {live.length} live streams at once. If it feels slow, switch to snapshots.</p>}
            </>
          );
        })()}
        {tile.type === "mediacalendar" && (() => {
          const arrs = integrations.filter(i => i.type === "sonarr" || i.type === "radarr");
          const chosen = (tile.config.integrationIds ?? []) as string[];
          const toggle = (id: string, on: boolean) => onChange({ integrationIds: on ? [...chosen, id] : chosen.filter(x => x !== id) });
          return (
            <>
              <div className="field"><span>Connections</span>
                {arrs.length ? (
                  <div className="list sec-pick">{arrs.map(a => (
                    <div key={a.id} className="li"><label className="chk"><input type="checkbox" checked={chosen.includes(a.id)} onChange={e => toggle(a.id, e.target.checked)} /> {a.name}</label><span className="sub">{a.type === "sonarr" ? "TV" : "Movies"}</span></div>
                  ))}</div>
                ) : <div className="row"><span className="sub">No Sonarr or Radarr connection yet.</span><button className="btn sm" onClick={onOpenConnections}>Add one</button></div>}
                <small>Tick as many as you have; they are merged into one calendar.</small></div>
              <Field label="Movie dates" hint="Which Radarr release dates to place on the calendar.">
                <select value={String(tile.config.release ?? "digital")} onChange={e => onChange({ release: e.target.value })}>
                  <option value="digital">Digital release</option><option value="cinema">In cinemas</option><option value="physical">Physical release</option><option value="all">All of them</option>
                </select>
              </Field>
              <Field label="Week starts on">
                <select value={String(tile.config.weekStart ?? "")} onChange={e => onChange({ weekStart: e.target.value || undefined })}><option value="">Dashboard default</option><option value="sun">Sunday</option><option value="mon">Monday</option></select>
              </Field>
            </>
          );
        })()}
        {SECTION_DEFS[tile.type] && (() => {
          const sections = resolveSections(tile.type, tile.config.sections);
          const save = (next: typeof sections) => onChange({ sections: next });
          const move = (i: number, d: number) => { const n = [...sections]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; save(n); };
          return (
            <div className="field"><span>Show on this tile</span>
              <div className="list sec-pick">
                {sections.map((s, i) => { const meta = SECTION_DEFS[tile.type].find(x => x.id === s.id)!; return (
                  <div key={s.id} className="li">
                    <label className="chk" title={meta.hint}><input type="checkbox" checked={s.on} onChange={e => save(sections.map(x => x.id === s.id ? { ...x, on: e.target.checked } : x))} /> {meta.label}</label>
                    <span className="sub trunc">{meta.hint}</span>
                    <button type="button" className="btn sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" className="btn sm" aria-label="Move down" disabled={i === sections.length - 1} onClick={() => move(i, 1)}>↓</button>
                  </div>
                ); })}
              </div>
            <small>Tick what to show and use the arrows to set the order. A section appears only when the app provides the data.</small></div>
          );
        })()}
        {tile.type === "clock" && <label className="chk"><input type="checkbox" checked={tile.config.hour24 === true} onChange={e => onChange({ hour24: e.target.checked })} /> 24-hour time</label>}
        {tile.type === "launcher" && (
          <>
            <div className="list">
              {items.map(item => (
                <div key={item.id} className="li launch-edit">
                  <IconButton icon={item.icon} iconRef={item.iconRef} name={item.name || "?"} onChange={v => patchItem(item.id, { icon: v.icon || null, iconRef: v.iconRef || null })} />
                  <input placeholder="Name" value={item.name} onChange={e => patchItem(item.id, { name: e.target.value })} maxLength={40} />
                  <input placeholder="https://…" value={item.url} onChange={e => patchItem(item.id, { url: e.target.value })} />
                  <select value={item.openMode ?? "tab"} onChange={e => patchItem(item.id, { openMode: e.target.value as "tab" | "inapp" })} title="Where this link opens" aria-label={`Where ${item.name || "this link"} opens`}><option value="tab">New tab</option><option value="inapp">Inside Homebase</option></select>
                  <select value={item.integrationId ?? ""} onChange={e => patchItem(item.id, { integrationId: e.target.value || null })} title="Show a status dot from a connection">
                    <option value="">No status</option>{integrations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <button type="button" className="btn sm" aria-label="Remove" onClick={() => saveItems(items.filter(i => i.id !== item.id))}>✕</button>
                </div>
              ))}
            </div>
            <button type="button" className="btn" onClick={() => saveItems([...items, { id: uid(), name: "", url: "http://" }])}>＋ Add app</button>
          </>
        )}
        <div className="acts"><span /><button type="button" className="btn pri" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}
