import { useState } from "react";
import { uid } from "../api";
import type { IntegrationInfo, Tile } from "../types";
import type { LauncherItem } from "../widgets/Launcher";
import { WIDGET_BY_TYPE } from "../widgets";
import { Field, Modal } from "./Modal";
import { iconUrl } from "../api";
import { initials } from "../widgets/common";

export function TileSettings({ tile, integrations, onChange, onPickIcon, onOpenConnections, onClose }: {
  tile: Tile; integrations: IntegrationInfo[]; onChange: (patch: Record<string, unknown>) => void;
  onPickIcon: (itemId: string) => void; onOpenConnections: () => void; onClose: () => void;
}) {
  const def = WIDGET_BY_TYPE[tile.type];
  const [items, setItems] = useState<LauncherItem[]>((tile.config.items ?? []) as LauncherItem[]);
  const options = integrations.filter(i => i.type === def?.needs);
  const saveItems = (next: LauncherItem[]) => { setItems(next); onChange({ items: next }); };
  const patchItem = (id: string, patch: Partial<LauncherItem>) => saveItems(items.map(i => (i.id === id ? { ...i, ...patch } : i)));

  return (
    <Modal title={`${def?.label ?? "Tile"} settings`} eyebrow="Tile" onClose={onClose} wide={tile.type === "launcher"}>
      <div className="form">
        <Field label="Title (optional)"><input defaultValue={String(tile.config.title ?? "")} onChange={e => onChange({ title: e.target.value })} maxLength={40} /></Field>
        {def?.needs && (
          <Field label="Connection" hint="Which connected app this tile shows.">
            {options.length ? (
              <select value={String(tile.config.integrationId ?? "")} onChange={e => onChange({ integrationId: e.target.value })}>
                <option value="">Choose…</option>{options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            ) : <div className="row"><span className="sub">No {def.label} connection yet.</span><button className="btn sm" onClick={onOpenConnections}>Add one</button></div>}
          </Field>
        )}
        {tile.type === "clock" && <label className="chk"><input type="checkbox" checked={tile.config.hour24 === true} onChange={e => onChange({ hour24: e.target.checked })} /> 24-hour time</label>}
        {tile.type === "launcher" && (
          <>
            <div className="list">
              {items.map(item => (
                <div key={item.id} className="li launch-edit">
                  <button type="button" className="icon-btn" title="Choose icon" onClick={() => onPickIcon(item.id)}>{item.icon ? <img src={iconUrl(item.icon)} alt="" /> : initials(item.name || "?")}</button>
                  <input placeholder="Name" value={item.name} onChange={e => patchItem(item.id, { name: e.target.value })} maxLength={40} />
                  <input placeholder="https://…" value={item.url} onChange={e => patchItem(item.id, { url: e.target.value })} />
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
