import { test } from "node:test";
import assert from "node:assert/strict";
import { firstFit, normalizeGroup, placeTile, reflow, resizeTile, settle, spanOf, withPositions } from "../../web/src/grid.js";
import type { Group, Tile } from "../../web/src/types.js";

const t = (id: string, w: number, h: number, x?: number, y?: number): Tile => ({ id, type: "notes", w, h, ...(x === undefined ? {} : { x, y }), config: {} });
const g = (tiles: Tile[], extra: Partial<Group> = {}): Group => ({ id: "g", name: "", layout: "free", collapsed: false, tiles, ...extra });
const at = (grp: Group, id: string) => { const x = grp.tiles.find(q => q.id === id)!; return [x.x, x.y]; };

test("grid: old ordered tiles get positions that look like the old flow, row by row", () => {
  const placed = withPositions([t("a", 3, 2), t("b", 3, 2), t("c", 3, 2), t("d", 2, 1)]);
  assert.deepEqual(placed.map(p => [p.x, p.y]), [[0, 0], [4, 0], [8, 0], [0, 2]], "three 4-column tiles fill a row; the next goes under");
  const fill = withPositions([t("a", 3, 2), t("b", 2, 1), t("c", 1, 1)]);
  assert.deepEqual(fill.map(p => [p.x, p.y]), [[0, 0], [4, 0], [7, 0]], "smaller tiles fill the row beside it");
  assert.equal(spanOf({ w: 4 }), 6);
});

test("grid: dropping a tile on another pushes the other one down; nothing overlaps", () => {
  const grp = g([t("a", 3, 2, 0, 0), t("b", 3, 2, 4, 0), t("c", 3, 2, 8, 0)]);
  const moved = placeTile(grp, grp.tiles[2], 0, 0);
  assert.deepEqual(at(moved, "c"), [0, 0]);
  assert.deepEqual(at(moved, "a"), [0, 2], "the tile that was there moves below");
  assert.deepEqual(at(moved, "b"), [4, 0], "tiles that are not in the way stay put");
});

test("grid: free placement leaves gaps; auto-pack closes them", () => {
  const free = placeTile(g([t("a", 3, 2, 0, 0), t("b", 3, 2, 4, 0)]), t("b", 3, 2, 4, 0), 4, 6);
  assert.deepEqual(at(free, "b"), [4, 6], "a tile stays exactly where it is dropped, leaving empty rows above");
  const packed = placeTile(g([t("a", 3, 2, 0, 0), t("b", 3, 2, 4, 0), t("c", 3, 2, 0, 5)], { pack: true }), t("b", 3, 2, 4, 0), 8, 0);
  assert.deepEqual(at(packed, "c"), [0, 2], "with auto-pack the tile below floats up into the gap");
});

test("grid: cascades push down in order, and a tile is kept inside the 12 columns", () => {
  const grp = g([t("a", 3, 2, 0, 0), t("b", 3, 2, 0, 2), t("c", 3, 2, 0, 4)]);
  const moved = placeTile(grp, t("n", 3, 2), 0, 0);
  assert.deepEqual([at(moved, "n"), at(moved, "a"), at(moved, "b"), at(moved, "c")], [[0, 0], [0, 2], [0, 4], [0, 6]]);
  assert.deepEqual(at(placeTile(grp, grp.tiles[0], 11, 0), "a"), [8, 0], "a 4-column tile cannot start in the last column");
  assert.equal(at(placeTile(grp, grp.tiles[0], -3, -5), "a")[0], 0);
});

test("grid: moving between groups removes nothing from the target and settles around the new tile", () => {
  const target = g([t("x", 6, 2, 0, 0)]);
  const out = placeTile(target, t("m", 4, 2), 0, 0);
  assert.deepEqual([at(out, "m"), at(out, "x")], [[0, 0], [0, 2]]);
});

test("grid: resizing pushes neighbours down instead of overlapping, and presets re-flow", () => {
  const grp = g([t("a", 2, 2, 0, 0), t("b", 2, 2, 3, 0)]);
  const wider = resizeTile(grp, "a", 4, 2);
  assert.deepEqual([at(wider, "a"), at(wider, "b")], [[0, 0], [3, 2]]);
  const flowed = reflow(g([t("a", 3, 2, 8, 9), t("b", 3, 2, 0, 20)]));
  assert.deepEqual([at(flowed, "a"), at(flowed, "b")], [[0, 0], [4, 0]]);
});

test("grid: bad saved data (overlaps, out of range) is repaired when loaded", () => {
  const fixed = normalizeGroup(g([t("a", 4, 2, 0, 0), t("b", 4, 2, 3, 1), t("c", 3, 2, 11, 0)]));
  const boxes = fixed.tiles;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(!(a.x! < b.x! + spanOf(b) && a.x! + spanOf(a) > b.x! && a.y! < b.y! + b.h && a.y! + a.h > b.y!), `${a.id} overlaps ${b.id}`);
  }
  assert.ok(fixed.tiles.every(q => q.x! + spanOf(q) <= 12));
  assert.deepEqual(firstFit([{ id: "a", x: 0, y: 0, cw: 12, h: 1 }], 4, 1), { x: 0, y: 1 });
  assert.equal(settle([], null, true).length, 0);
});
