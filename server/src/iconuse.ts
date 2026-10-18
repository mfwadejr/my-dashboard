import { readDashboard, writeDashboard } from "./dashboard.js";
import { tx, type DB } from "./db.js";
import { iconFile } from "./icons.js";

export type HolderKind = "connection" | "camera" | "account" | "token" | "tab" | "tile" | "launcher";
/** Something that carries an icon. `key` is "kind:id" (a Launcher item is "launcher:<tile>/<item>"). */
export interface Holder { key: string; kind: HolderKind; id: string; name: string; icon: string; iconRef: string }
export const KIND_NAMES: Record<HolderKind, string> = { connection: "Connection", camera: "Camera", account: "Person", token: "API token", tab: "Tab", tile: "Tile", launcher: "Launcher item" };

const TABLES: Array<{ kind: "connection" | "camera" | "account" | "token"; table: string; name: string }> = [
  { kind: "connection", table: "integrations", name: "name" }, { kind: "camera", table: "cameras", name: "name" },
  { kind: "account", table: "users", name: "username" }, { kind: "token", table: "api_tokens", name: "name" }
];

/** Every place an icon can be, with what it holds now. */
export function listHolders(db: DB): Holder[] {
  const out: Holder[] = [];
  for (const t of TABLES) {
    for (const r of db.prepare(`SELECT id, ${t.name} AS name, icon, icon_ref FROM ${t.table}`).all() as unknown as Array<{ id: string; name: string; icon: string; icon_ref: string }>) {
      if (r.icon) out.push({ key: `${t.kind}:${r.id}`, kind: t.kind, id: r.id, name: r.name, icon: r.icon, iconRef: r.icon_ref });
    }
  }
  const doc = readDashboard(db);
  for (const tab of doc.tabs) {
    if (tab.icon) out.push({ key: `tab:${tab.id}`, kind: "tab", id: tab.id, name: tab.name, icon: tab.icon, iconRef: tab.iconRef });
    for (const g of tab.groups) for (const tile of g.tiles) {
      const c = tile.config as { icon?: string; iconRef?: string; title?: string; items?: Array<{ id?: string; name?: string; icon?: string; iconRef?: string }> };
      if (c.icon) out.push({ key: `tile:${tile.id}`, kind: "tile", id: tile.id, name: String(c.title || tile.type), icon: c.icon, iconRef: c.iconRef ?? "" });
      if (Array.isArray(c.items)) for (const it of c.items) if (it?.icon && it.id) out.push({ key: `launcher:${tile.id}/${it.id}`, kind: "launcher", id: `${tile.id}/${it.id}`, name: String(it.name || "Launcher item"), icon: it.icon, iconRef: it.iconRef ?? "" });
    }
  }
  return out;
}

/** The saved files that are in use (as "used/…" names or older flat ids). Works on any Homebase database, including a copy that is not live. */
export function referencedIcons(db: DB): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v) out.add(iconFile(v)); };
  for (const t of ["integrations", "cameras", "users", "api_tokens", "tabs"]) {
    try { for (const r of db.prepare(`SELECT icon FROM ${t} WHERE icon <> ''`).all() as unknown as Array<{ icon: string }>) add(r.icon); } catch { /* an older layout has no icon column */ }
  }
  try {
    for (const r of db.prepare("SELECT config FROM tiles").all() as unknown as Array<{ config: string }>) {
      try { const c = JSON.parse(r.config) as { icon?: string; items?: Array<{ icon?: string }> }; add(c.icon); if (Array.isArray(c.items)) for (const it of c.items) add(it?.icon); } catch { /* one damaged tile */ }
    }
  } catch { /* no tiles table */ }
  return out;
}
export const usedFiles = referencedIcons;

/** Sets (or, with an empty icon, clears) the icon on a thing. Returns false when the thing does not exist. */
export function setIcon(db: DB, kind: HolderKind, id: string, icon: string, iconRef: string): boolean {
  const t = TABLES.find(x => x.kind === kind);
  if (t) return Number(db.prepare(`UPDATE ${t.table} SET icon = ?, icon_ref = ? WHERE id = ?`).run(icon, icon ? iconRef : "", id).changes) > 0;
  return applyToDoc(db, new Map([[`${kind}:${id}`, { icon, iconRef }]])) > 0;
}

/** Applies several changes at once (keys as in Holder.key). Returns how many things changed. */
export function applyIcons(db: DB, changes: Map<string, { icon: string; iconRef: string }>): number {
  let n = 0;
  const doc = new Map<string, { icon: string; iconRef: string }>();
  tx(db, () => {
    for (const [key, v] of changes) {
      const i = key.indexOf(":"), kind = key.slice(0, i) as HolderKind, id = key.slice(i + 1);
      const t = TABLES.find(x => x.kind === kind);
      if (t) n += Number(db.prepare(`UPDATE ${t.table} SET icon = ?, icon_ref = ? WHERE id = ?`).run(v.icon, v.icon ? v.iconRef : "", id).changes);
      else doc.set(key, v);
    }
  });
  if (doc.size) n += applyToDoc(db, doc);
  return n;
}

function applyToDoc(db: DB, changes: Map<string, { icon: string; iconRef: string }>): number {
  const cur = readDashboard(db);
  let n = 0;
  const put = (o: { icon?: string; iconRef?: string }, v: { icon: string; iconRef: string }) => { if (v.icon) { o.icon = v.icon; o.iconRef = v.iconRef; } else { delete o.icon; delete o.iconRef; } n++; };
  for (const tab of cur.tabs) {
    const tv = changes.get(`tab:${tab.id}`);
    if (tv) { tab.icon = tv.icon; tab.iconRef = tv.icon ? tv.iconRef : ""; n++; }
    for (const g of tab.groups) for (const tile of g.tiles) {
      const v = changes.get(`tile:${tile.id}`);
      if (v) put(tile.config as Record<string, string>, v);
      const items = (tile.config as { items?: Array<{ id?: string; icon?: string; iconRef?: string }> }).items;
      if (Array.isArray(items)) for (const it of items) { const iv = it?.id ? changes.get(`launcher:${tile.id}/${it.id}`) : undefined; if (iv) put(it, iv); }
    }
  }
  if (n) writeDashboard(db, { tabs: cur.tabs }, cur.revision);
  return n;
}
