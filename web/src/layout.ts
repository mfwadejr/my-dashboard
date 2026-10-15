import type { Group, Tile } from "./types";

/** Re-size a group's camera/tile set so they line up in a preset arrangement. Widths use 12-column units: 1=2 cols, 2=3, 3=4, 4=6, 5=8, 6=12. */
export function applyLayout(group: Group): Group {
  const layout = group.layout;
  if (layout === "free") return group;
  const preset: Record<string, [number, number]> = { grid2: [4, 4], grid3: [3, 3], grid4: [2, 2], row: [6, 4] };
  const eligible = group.tiles.filter(t => t.type === "camera");
  const side = Math.min(eligible.length - 1, 3);
  const size = new Map<string, [number, number]>();
  eligible.forEach((tile, n) => {
    size.set(tile.id, layout === "spot" ? (n === 0 ? [5, Math.max(4, 2 * side)] : n <= 3 ? [3, 2] : [2, 2]) : preset[layout]);
  });
  return { ...group, tiles: group.tiles.map(t => (size.has(t.id) ? { ...t, w: size.get(t.id)![0], h: size.get(t.id)![1] } : t)) };
}

export const LAYOUTS: Array<[string, string]> = [
  ["free", "Free layout"], ["grid2", "2 per row"], ["grid3", "3 per row"], ["grid4", "4 per row"], ["spot", "Spotlight 1 + side"], ["row", "Full width"]
];

export const COLS: Record<number, number> = { 1: 2, 2: 3, 3: 4, 4: 6, 5: 8, 6: 12 };

export function moveTile(groups: Group[], tileId: string, toGroupId: string, beforeTileId: string | null): Group[] {
  let moved: Tile | undefined;
  const without = groups.map(g => {
    const found = g.tiles.find(t => t.id === tileId);
    if (found) moved = found;
    return { ...g, tiles: g.tiles.filter(t => t.id !== tileId) };
  });
  if (!moved) return groups;
  return without.map(g => {
    if (g.id !== toGroupId) return g;
    const at = beforeTileId ? g.tiles.findIndex(t => t.id === beforeTileId) : -1;
    const tiles = [...g.tiles];
    tiles.splice(at < 0 ? tiles.length : at, 0, moved!);
    return { ...g, tiles };
  });
}
