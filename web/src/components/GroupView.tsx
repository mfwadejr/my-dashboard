import type { PointerEvent as RPointerEvent } from "react";
import type { Group, Tile } from "../types";
import { LAYOUTS } from "../layout";
import { rowsUsed } from "../grid";
import { WIDGETS } from "../widgets";
import { TileFrame, type FrameProps } from "./TileFrame";

type Shared = Omit<FrameProps, "tile" | "lifted" | "onGrab" | "gridWidth">;
export interface Placeholder { x: number; y: number; cw: number; h: number }

export function GroupView({ group, tiles, placeholder, liftedId, minRows, editing, shared, onRename, onLayout, onPack, onToggle, onDelete, onAddTile, onGrab, canDelete }: {
  group: Group; tiles: Tile[]; placeholder: Placeholder | null; liftedId: string | null; minRows: number; editing: boolean; shared: Shared; canDelete: boolean;
  onRename: (name: string) => void; onLayout: (layout: string) => void; onPack: (on: boolean) => void; onToggle: () => void; onDelete: () => void;
  onAddTile: (type: string) => void; onGrab: (tile: Tile, groupId: string, e: RPointerEvent<HTMLElement>) => void;
}) {
  // While editing there are always two spare rows below the tiles, so there is somewhere to drop a tile at the bottom.
  const rows = Math.max(minRows, rowsUsed(tiles) + (editing ? 2 : 0));
  return (
    <section className={`grp ${group.collapsed ? "collapsed" : ""}`}>
      <div className="gh">
        <button className="gbtn" aria-label={group.collapsed ? "Expand group" : "Collapse group"} onClick={onToggle}>{group.collapsed ? "▸" : "▾"}</button>
        {editing ? <input className="gname" value={group.name} maxLength={60} onChange={e => onRename(e.target.value)} aria-label="Group name" placeholder="Group name" /> : <span className="gtitle">{group.name}</span>}
        <span className="sub">{group.tiles.length} tile{group.tiles.length === 1 ? "" : "s"}</span>
        {editing && (
          <div className="gtools">
            <label className="chk" title="Tiles float up to fill empty space above them. Off: tiles stay exactly where you drop them."><input type="checkbox" checked={Boolean(group.pack)} onChange={e => onPack(e.target.checked)} /> Auto-pack</label>
            <select value={group.layout} onChange={e => onLayout(e.target.value)} aria-label="Arrange tiles" title="Arrange the camera tiles in this group in a preset pattern. Moving a tile yourself switches back to Free.">{LAYOUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <select value="" onChange={e => { if (e.target.value) onAddTile(e.target.value); }} aria-label="Add tile"><option value="">＋ Add tile…</option>{WIDGETS.map(w => <option key={w.type} value={w.type}>{w.label}</option>)}</select>
            {canDelete && <button className="btn sm" onClick={onDelete}>Delete group</button>}
          </div>
        )}
      </div>
      <div className={`grid ${tiles.length === 0 && !placeholder ? "empty" : ""}`} data-grid={group.id} style={editing ? { gridTemplateRows: `repeat(${rows}, var(--row))` } : undefined}>
        {tiles.map((tile: Tile) => (
          <TileFrame key={tile.id} {...shared} tile={tile} lifted={liftedId === tile.id}
            gridWidth={() => document.querySelector<HTMLElement>(`[data-grid="${group.id}"]`)?.clientWidth ?? 1200}
            onGrab={(t, e) => onGrab(t, group.id, e)} />
        ))}
        {placeholder && <div className="ph" style={{ gridColumn: `${placeholder.x + 1} / span ${placeholder.cw}`, gridRow: `${placeholder.y + 1} / span ${placeholder.h}` }} />}
      </div>
    </section>
  );
}
