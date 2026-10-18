import { COLS } from "./layout";
import type { Group, Tab, Tile } from "./types";

/** Tiles live on a 12-column grid with fixed-height rows. A tile's width is one of six steps (see COLS); x is the first column, y the first row. */
export const GRID_COLS = 12;
export const ROW_H = 84;
export const clampCol = (x: number, cw: number) => Math.max(0, Math.min(GRID_COLS - cw, Math.round(x)));
export const spanOf = (t: { w: number }): number => COLS[t.w] ?? 4;

export interface Box { id: string; x: number; y: number; cw: number; h: number }
const boxOf = (t: Tile): Box => ({ id: t.id, x: t.x ?? 0, y: t.y ?? 0, cw: spanOf(t), h: t.h });
const hit = (a: Box, b: Box) => a.x < b.x + b.cw && a.x + a.cw > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const clampX = (x: number, cw: number) => Math.max(0, Math.min(GRID_COLS - cw, Math.round(x)));
const hasPos = (t: Tile) => Number.isInteger(t.x) && Number.isInteger(t.y);

/**
 * Settle tiles around an optional fixed box (the tile being dragged or resized). Others keep their spot unless something sits on it,
 * in which case they are pushed down below it. With `pack`, tiles also float up into any empty space above them.
 */
export function settle(tiles: Tile[], fixed: Box | null, pack: boolean): Tile[] {
  const placed: Box[] = fixed ? [fixed] : [];
  const out = new Map<string, { x: number; y: number }>();
  for (const t of [...tiles].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))) {
    const b = boxOf(t);
    b.x = clampX(b.x, b.cw);
    if (pack) while (b.y > 0 && !placed.some(p => hit({ ...b, y: b.y - 1 }, p))) b.y--;
    let blocker: Box | undefined;
    while ((blocker = placed.find(p => hit(b, p)))) b.y = blocker.y + blocker.h;
    placed.push(b);
    out.set(t.id, { x: b.x, y: b.y });
  }
  return tiles.map(t => ({ ...t, ...out.get(t.id)! }));
}

/** First free spot (row by row, left to right) for a tile of this size, given what is already placed. */
export function firstFit(placed: Box[], cw: number, h: number): { x: number; y: number } {
  for (let y = 0; y < 1000; y++) for (let x = 0; x <= GRID_COLS - cw; x++) if (!placed.some(p => hit({ id: "", x, y, cw, h }, p))) return { x, y };
  return { x: 0, y: 0 };
}

/** Give every tile without a spot one. Old dashboards (saved as an ordered list) end up looking the way they did before. */
export function withPositions(tiles: Tile[]): Tile[] {
  if (tiles.every(hasPos)) return tiles;
  const placed = tiles.filter(hasPos).map(boxOf);
  return tiles.map(t => {
    if (hasPos(t)) return t;
    const spot = firstFit(placed, spanOf(t), t.h);
    placed.push({ id: t.id, ...spot, cw: spanOf(t), h: t.h });
    return { ...t, ...spot };
  });
}

/** A group with every tile placed and no overlaps. */
export function normalizeGroup(g: Group): Group {
  const placed = withPositions(g.tiles);
  const same = placed === g.tiles && !g.pack;
  if (same && !overlaps(placed)) return g;
  return { ...g, tiles: settle(placed, null, Boolean(g.pack)) };
}
export const normalizeTab = (t: Tab): Tab => ({ ...t, groups: t.groups.map(normalizeGroup) });

function overlaps(tiles: Tile[]): boolean {
  const boxes = tiles.map(boxOf);
  return boxes.some((a, i) => boxes.slice(i + 1).some(b => hit(a, b)));
}

/** Forget positions and lay the tiles out again in order. Used by the arrangement presets. */
export const reflow = (g: Group): Group => ({ ...g, tiles: withPositions(g.tiles.map(({ x: _x, y: _y, ...rest }) => rest)) });

/** Move one tile to a spot in a group (the group may be a different one from where the tile came from). */
export function placeTile(g: Group, tile: Tile, x: number, y: number): Group {
  const cw = spanOf(tile);
  const spot = { x: clampX(x, cw), y: Math.max(0, Math.round(y)) };
  const others = g.tiles.filter(t => t.id !== tile.id);
  const settled = settle(others, { id: tile.id, ...spot, cw, h: tile.h }, Boolean(g.pack));
  const moved = { ...tile, ...spot };
  const at = g.tiles.findIndex(t => t.id === tile.id);
  const tiles = at >= 0 ? g.tiles.map(t => (t.id === tile.id ? moved : settled.find(s => s.id === t.id)!)) : [...settled, moved];
  return { ...g, layout: g.layout === "free" ? g.layout : "free", tiles };
}

/** The tile the user resized: it keeps its spot, anything in the way is pushed down. */
export function resizeTile(g: Group, id: string, w: number, h: number): Group {
  const t = g.tiles.find(x => x.id === id);
  if (!t) return g;
  const resized = { ...t, w, h, x: clampX(t.x ?? 0, spanOf({ w })) };
  const others = settle(g.tiles.filter(x => x.id !== id), { id, x: resized.x, y: resized.y ?? 0, cw: spanOf(resized), h }, Boolean(g.pack));
  return { ...g, layout: "free", tiles: g.tiles.map(x => (x.id === id ? resized : others.find(o => o.id === x.id)!)) };
}

/** Rows used, so the grid can be tall enough. */
export const rowsUsed = (tiles: Tile[]): number => tiles.reduce((m, t) => Math.max(m, (t.y ?? 0) + t.h), 0);
