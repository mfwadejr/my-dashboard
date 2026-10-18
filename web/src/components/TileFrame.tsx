import { useRef, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import type { Tile } from "../types";
import { COLS } from "../layout";
import { spanOf } from "../grid";
import { WIDGET_BY_TYPE } from "../widgets";
import type { WidgetProps } from "../widgets/types";

export interface FrameProps extends Omit<WidgetProps, "setConfig" | "openSettings"> {
  gridWidth: () => number;
  lifted: boolean;
  onGrab: (tile: Tile, e: RPointerEvent<HTMLElement>) => void;
  onResize: (id: string, w: number, h: number) => void;
  onRemove: (id: string) => void;
  onConfig: (id: string, patch: Record<string, unknown>) => void;
  onSettings: (tile: Tile) => void;
}

const ROW = 84;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function TileFrame(p: FrameProps) {
  const { tile, editing } = p;
  const def = WIDGET_BY_TYPE[tile.type];
  const start = useRef<{ x: number; y: number; w: number; h: number; colPx: number } | null>(null);

  const onHandleDown = (e: RPointerEvent<HTMLButtonElement>) => {
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY, w: tile.w, h: tile.h, colPx: p.gridWidth() / 12 };
  };
  const onHandleMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const s = start.current; if (!s) return;
    const widthCols = COLS[s.w] + (e.clientX - s.x) / s.colPx;
    let w = s.w;
    let best = Infinity;
    for (const [k, c] of Object.entries(COLS)) { const d = Math.abs(c - widthCols); if (d < best) { best = d; w = Number(k); } }
    const h = clamp(Math.round(s.h + (e.clientY - s.y) / (ROW + 14)), 1, 8);
    if (w !== tile.w || h !== tile.h) p.onResize(tile.id, w, h);
  };
  const onHandleUp = () => { start.current = null; };

  const props: WidgetProps = { ...p, setConfig: patch => p.onConfig(tile.id, patch), openSettings: () => p.onSettings(tile) };
  const Body = def?.component;
  const cam = tile.type === "camera" || tile.type === "camerawall";
  const x = tile.x ?? 0, y = tile.y ?? 0;
  // Explicit grid cell; `order` and --h give phones a sensible reading order when the grid collapses to one column.
  const place = { gridColumn: `${x + 1} / span ${spanOf(tile)}`, gridRow: `${y + 1} / span ${tile.h}`, order: y * 12 + x, ["--h" as string]: tile.h } as CSSProperties;
  return (
    <div className={`tile ${cam ? "cam" : ""} ${p.lifted ? "lifted" : ""}`} style={place} data-tile={tile.id}>
      {Body ? <Body {...props} /> : <div className="empty-note">Unknown tile “{tile.type}”.</div>}
      {editing && (
        <>
          <div className="dragzone" aria-label="Drag to move" onPointerDown={e => p.onGrab(tile, e)} />
          <div className="ctl">
            <button title="Settings" aria-label="Tile settings" onClick={() => p.onSettings(tile)}>⚙</button>
            <button title="Remove" aria-label="Remove tile" onClick={() => p.onRemove(tile.id)}>✕</button>
          </div>
          <span className="sizeLbl">{COLS[tile.w]}×{tile.h}</span>
          <button className="resize" aria-label="Resize tile" onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} />
        </>
      )}
    </div>
  );
}
