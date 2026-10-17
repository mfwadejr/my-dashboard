import { randomUUID } from "node:crypto";
import { getMeta, setMeta, tx, type DB } from "./db.js";

export const TILE_TYPES = ["clock", "notes", "launcher", "sonarr", "radarr", "sabnzbd", "camera", "camerawall", "prowlarr", "sitegateway", "unifi-network", "unifi-protect", "unifi-pdu","unifi-unas","mediacalendar", "unraid", "zimaos"] as const;
export const GROUP_LAYOUTS = ["free", "grid2", "grid3", "grid4", "spot", "row"] as const;

export interface TileDoc { id: string; type: string; w: number; h: number; config: Record<string, unknown> }
export interface GroupDoc { id: string; name: string; layout: string; collapsed: boolean; tiles: TileDoc[] }
export interface TabDoc { id: string; name: string; emoji: string; groups: GroupDoc[] }
export interface DashboardDoc { revision: number; tabs: TabDoc[] }

export class ValidationError extends Error {}
export class ConflictError extends Error {
  constructor(public latest: DashboardDoc) { super("The dashboard was changed somewhere else"); }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LIMITS = { tabs: 30, groupsPerTab: 20, tilesPerGroup: 80, config: 20_000 };

export function readDashboard(db: DB): DashboardDoc {
  const revision = Number(getMeta(db, "dashboard_revision") ?? 0);
  const tabs = db.prepare("SELECT id, name, emoji FROM tabs ORDER BY position").all() as unknown as Array<{ id: string; name: string; emoji: string }>;
  const groups = db.prepare("SELECT id, tab_id, name, layout, collapsed FROM groups ORDER BY position").all() as unknown as Array<{ id: string; tab_id: string; name: string; layout: string; collapsed: number }>;
  const tiles = db.prepare("SELECT id, group_id, type, w, h, config FROM tiles ORDER BY position").all() as unknown as Array<{ id: string; group_id: string; type: string; w: number; h: number; config: string }>;
  return {
    revision,
    tabs: tabs.map(tab => ({
      id: tab.id, name: tab.name, emoji: tab.emoji,
      groups: groups.filter(g => g.tab_id === tab.id).map(g => ({
        id: g.id, name: g.name, layout: g.layout, collapsed: Boolean(g.collapsed),
        tiles: tiles.filter(t => t.group_id === g.id).map(t => ({ id: t.id, type: t.type, w: t.w, h: t.h, config: JSON.parse(t.config) }))
      }))
    }))
  };
}

function str(value: unknown, field: string, max: number, allowEmpty = true): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw new ValidationError(`${field} is required`);
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`);
  return trimmed;
}

function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ValidationError(`${field} must be a whole number from ${min} to ${max}`);
  return value;
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new ValidationError(`${field} id is invalid`);
  return value;
}

/** Validate and normalize an untrusted dashboard document from the browser. */
export function validateDashboard(input: unknown): { tabs: TabDoc[] } {
  if (!input || typeof input !== "object" || !Array.isArray((input as any).tabs)) throw new ValidationError("tabs are required");
  const rawTabs = (input as any).tabs as unknown[];
  if (rawTabs.length < 1) throw new ValidationError("At least one tab is required");
  if (rawTabs.length > LIMITS.tabs) throw new ValidationError("Too many tabs");
  const seen = new Set<string>();
  const unique = (value: string, kind: string) => { if (seen.has(value)) throw new ValidationError(`Duplicate ${kind} id`); seen.add(value); return value; };

  const tabs = rawTabs.map((rawTab: any): TabDoc => {
    if (!Array.isArray(rawTab?.groups) || rawTab.groups.length < 1) throw new ValidationError("Each tab needs at least one group");
    if (rawTab.groups.length > LIMITS.groupsPerTab) throw new ValidationError("Too many groups in a tab");
    return {
      id: unique(id(rawTab.id, "Tab"), "tab"),
      name: str(rawTab.name, "Tab name", 60, false),
      emoji: str(rawTab.emoji ?? "", "Tab emoji", 8),
      groups: rawTab.groups.map((rawGroup: any): GroupDoc => {
        if (!Array.isArray(rawGroup?.tiles)) throw new ValidationError("Each group needs a tiles list");
        if (rawGroup.tiles.length > LIMITS.tilesPerGroup) throw new ValidationError("Too many tiles in a group");
        const layout = String(rawGroup.layout ?? "free");
        if (!(GROUP_LAYOUTS as readonly string[]).includes(layout)) throw new ValidationError("Unknown group layout");
        return {
          id: unique(id(rawGroup.id, "Group"), "group"),
          name: str(rawGroup.name ?? "", "Group name", 60),
          layout, collapsed: Boolean(rawGroup.collapsed),
          tiles: rawGroup.tiles.map((rawTile: any): TileDoc => {
            const type = String(rawTile?.type);
            if (!(TILE_TYPES as readonly string[]).includes(type)) throw new ValidationError(`Unknown tile type "${type}"`);
            const config = rawTile.config ?? {};
            if (typeof config !== "object" || Array.isArray(config)) throw new ValidationError("Tile config must be an object");
            if (JSON.stringify(config).length > LIMITS.config) throw new ValidationError("Tile config is too large");
            return { id: unique(id(rawTile.id, "Tile"), "tile"), type, w: int(rawTile.w, "Tile width", 1, 6), h: int(rawTile.h, "Tile height", 1, 8), config };
          })
        };
      })
    };
  });
  return { tabs };
}

/** Replace the whole layout in one transaction. Optimistic concurrency via the revision number. */
export function writeDashboard(db: DB, doc: { tabs: TabDoc[] }, baseRevision: number): DashboardDoc {
  return tx(db, () => {
    const current = Number(getMeta(db, "dashboard_revision") ?? 0);
    if (baseRevision !== current) throw new ConflictError(readDashboard(db));
    db.exec("DELETE FROM tiles; DELETE FROM groups; DELETE FROM tabs;");
    const insTab = db.prepare("INSERT INTO tabs (id, name, emoji, position) VALUES (?, ?, ?, ?)");
    const insGroup = db.prepare("INSERT INTO groups (id, tab_id, name, layout, collapsed, position) VALUES (?, ?, ?, ?, ?, ?)");
    const insTile = db.prepare("INSERT INTO tiles (id, group_id, type, w, h, position, config) VALUES (?, ?, ?, ?, ?, ?, ?)");
    doc.tabs.forEach((tab, ti) => {
      insTab.run(tab.id, tab.name, tab.emoji, ti);
      tab.groups.forEach((group, gi) => {
        insGroup.run(group.id, tab.id, group.name, group.layout, group.collapsed ? 1 : 0, gi);
        group.tiles.forEach((tile, ki) => insTile.run(tile.id, group.id, tile.type, tile.w, tile.h, ki, JSON.stringify(tile.config)));
      });
    });
    setMeta(db, "dashboard_revision", String(current + 1));
    return readDashboard(db);
  });
}

export function seedIfEmpty(db: DB): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM tabs").get() as { n: number };
  if (count.n > 0) return;
  const tile = (type: string, w: number, h: number, config: Record<string, unknown> = {}): TileDoc => ({ id: randomUUID().slice(0, 12), type, w, h, config });
  writeDashboard(db, {
    tabs: [{
      id: "home", name: "Home", emoji: "",
      groups: [{
        id: "main", name: "", layout: "free", collapsed: false,
        tiles: [
          tile("clock", 3, 1),
          tile("notes", 3, 2, { text: "Welcome to Homebase.\n\n1. Sign in and click Edit layout.\n2. Open Settings to connect Sonarr, Radarr or SABnzbd.\n3. Add tiles, resize them, and drag them into groups or new tabs." })
        ]
      }]
    }]
  }, 0);
}
