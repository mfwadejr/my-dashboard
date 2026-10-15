import { useRef } from "react";
import type { Group, Tile } from "../types";
import { LAYOUTS } from "../layout";
import { WIDGETS } from "../widgets";
import { TileFrame, type FrameProps } from "./TileFrame";

type Shared = Omit<FrameProps, "tile" | "dragging" | "onDropOn" | "gridWidth">;

export function GroupView({ group, editing, dragId, shared, onRename, onLayout, onToggle, onDelete, onAddTile, onDropIn, canDelete }: {
  group: Group; editing: boolean; dragId: string | null; shared: Shared; canDelete: boolean;
  onRename: (name: string) => void; onLayout: (layout: string) => void; onToggle: () => void; onDelete: () => void;
  onAddTile: (type: string) => void; onDropIn: (groupId: string, beforeId: string | null) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const visible = group.tiles;
  return (
    <section className={`grp ${group.collapsed ? "collapsed" : ""}`}>
      <div className="gh">
        <button className="gbtn" aria-label={group.collapsed ? "Expand group" : "Collapse group"} onClick={onToggle}>{group.collapsed ? "▸" : "▾"}</button>
        {editing ? <input className="gname" value={group.name} maxLength={60} onChange={e => onRename(e.target.value)} aria-label="Group name" placeholder="Group name" /> : <span className="gtitle">{group.name}</span>}
        <span className="sub">{group.tiles.length} tile{group.tiles.length === 1 ? "" : "s"}</span>
        {editing && (
          <div className="gtools">
            <select value={group.layout} onChange={e => onLayout(e.target.value)} aria-label="Group layout">{LAYOUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <select value="" onChange={e => { if (e.target.value) onAddTile(e.target.value); }} aria-label="Add tile"><option value="">＋ Add tile…</option>{WIDGETS.map(w => <option key={w.type} value={w.type}>{w.label}</option>)}</select>
            {canDelete && <button className="btn sm" onClick={onDelete}>Delete group</button>}
          </div>
        )}
      </div>
      <div
        ref={grid}
        className={`grid ${visible.length === 0 ? "empty" : ""}`}
        onDragOver={e => { if (editing) e.preventDefault(); }}
        onDrop={e => { if (!editing) return; e.preventDefault(); onDropIn(group.id, null); }}
      >
        {visible.map((tile: Tile) => (
          <TileFrame key={tile.id} {...shared} tile={tile} dragging={dragId === tile.id}
            gridWidth={() => grid.current?.clientWidth ?? 1200}
            onDropOn={before => onDropIn(group.id, before)} />
        ))}
      </div>
    </section>
  );
}
