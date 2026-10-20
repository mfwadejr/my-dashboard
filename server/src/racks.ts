import { randomUUID } from "node:crypto";
import { ValidationError } from "./dashboard.js";
import { tx, type DB } from "./db.js";
import { cleanIcon, cleanIconRef } from "./icons.js";

export const RACK_MAX_UNITS = 60;
export const DEVICE_KINDS = ["generic", "switch", "patch", "router", "server", "nas", "pdu", "ups", "shelf", "blank", "cable"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export type Face = "front" | "rear" | "both";

export interface RackDevice {
  id: string; rackId: string; name: string; kind: DeviceKind; units: number;
  /** The lowest unit the device covers, counted from the bottom of the rack. */
  slot: number;
  /** Which side of the rack it occupies. A half-depth device on the front leaves the rear free. */
  face: Face;
  /** 19 or 10 (inches). A device wider than its rack is flagged in the page, not refused. */
  width: 19 | 10;
  /** "" or "1".."6": one of the theme's accent colours. */
  color: string; ports: number; watts: number | null; integrationId: string; notes: string; icon: string; iconRef: string; rearIcon: string; rearIconRef: string; fit: "stretch" | "fit" | "fill"; look: "drawn" | "image";
}
export interface Rack { id: string; name: string; units: number; width: 19 | 10; topDown: boolean; notes: string; position: number; devices: RackDevice[] }

interface RackRaw { id: string; name: string; units: number; width: number; top_down: number; notes: string; position: number }
interface DevRaw { id: string; rack_id: string; name: string; kind: string; units: number; slot: number; face: string; width: number; color: string; ports: number; watts: number | null; integration_id: string; notes: string; icon: string; icon_ref: string; look: string; rear_icon: string; rear_icon_ref: string; fit: string }
const RCOLS = "id, name, units, width, top_down, notes, position";
const DCOLS = "id, rack_id, name, kind, units, slot, face, width, color, ports, watts, integration_id, notes, icon, icon_ref, look, rear_icon, rear_icon_ref, fit";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown, lo: number, hi: number, what: string): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < lo || n > hi) throw new ValidationError(`${what} must be a whole number from ${lo} to ${hi}`);
  return n;
};

const mapDev = (r: DevRaw): RackDevice => ({
  id: r.id, rackId: r.rack_id, name: r.name, kind: (DEVICE_KINDS as readonly string[]).includes(r.kind) ? r.kind as DeviceKind : "generic", units: r.units, slot: r.slot,
  face: r.face === "front" || r.face === "rear" ? r.face : "both", width: r.width === 10 ? 10 : 19, color: r.color, ports: r.ports, watts: r.watts, integrationId: r.integration_id, notes: r.notes,
  icon: r.icon, iconRef: r.icon_ref, rearIcon: r.rear_icon, rearIconRef: r.rear_icon_ref, fit: r.fit === "fit" || r.fit === "fill" ? r.fit : "stretch", look: r.look === "image" ? "image" : "drawn"
});

const occupies = (face: Face) => (face === "both" ? ["front", "rear"] : [face]);
const clash = (a: { slot: number; units: number; face: Face }, b: { slot: number; units: number; face: Face }) =>
  a.slot < b.slot + b.units && b.slot < a.slot + a.units && occupies(a.face).some(f => occupies(b.face).includes(f));

/** Server racks: their size and what sits in them. Everything here is plain data; live status is joined in the browser. */
export class Racks {
  constructor(private db: DB) {}

  private devicesOf(rackId: string): RackDevice[] {
    return (this.db.prepare(`SELECT ${DCOLS} FROM rack_devices WHERE rack_id = ? ORDER BY slot, created_at`).all(rackId) as unknown as DevRaw[]).map(mapDev);
  }
  private mapRack(r: RackRaw): Rack {
    return { id: r.id, name: r.name, units: r.units, width: r.width === 10 ? 10 : 19, topDown: Boolean(r.top_down), notes: r.notes, position: r.position, devices: this.devicesOf(r.id) };
  }

  list(withNotes = true): Rack[] {
    const racks = (this.db.prepare(`SELECT ${RCOLS} FROM racks ORDER BY position, created_at`).all() as unknown as RackRaw[]).map(r => this.mapRack(r));
    if (!withNotes) for (const r of racks) { r.notes = ""; for (const d of r.devices) d.notes = ""; }
    return racks;
  }
  get(id: string): Rack | undefined {
    const r = this.db.prepare(`SELECT ${RCOLS} FROM racks WHERE id = ?`).get(id) as unknown as RackRaw | undefined;
    return r ? this.mapRack(r) : undefined;
  }
  getDevice(id: string): RackDevice | undefined {
    const r = this.db.prepare(`SELECT ${DCOLS} FROM rack_devices WHERE id = ?`).get(id) as unknown as DevRaw | undefined;
    return r ? mapDev(r) : undefined;
  }

  private cleanRack(input: unknown, old?: Rack) {
    const b = (input ?? {}) as Record<string, unknown>;
    const name = text(b.name ?? old?.name, 60);
    if (!name) throw new ValidationError("Give the rack a name");
    const units = int(b.units ?? old?.units ?? 42, 1, RACK_MAX_UNITS, "The rack height");
    const width = Number(b.width ?? old?.width ?? 19) === 10 ? 10 : 19;
    const topDown = b.topDown === undefined ? old?.topDown ?? false : Boolean(b.topDown);
    return { name, units, width: width as 10 | 19, topDown, notes: text(b.notes ?? old?.notes ?? "", 2000) };
  }

  createRack(input: unknown): Rack {
    const c = this.cleanRack(input);
    const id = "r" + randomUUID().replace(/-/g, "").slice(0, 10);
    const pos = Number((this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM racks").get() as { n: number }).n);
    this.db.prepare("INSERT INTO racks (id, name, units, width, top_down, notes, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, c.name, c.units, c.width, c.topDown ? 1 : 0, c.notes, pos, Date.now());
    return this.get(id)!;
  }

  updateRack(id: string, input: unknown): Rack | undefined {
    const old = this.get(id);
    if (!old) return undefined;
    const c = this.cleanRack(input, old);
    // A smaller rack must still hold everything in it.
    const top = old.devices.reduce((m, d) => Math.max(m, d.slot + d.units - 1), 0);
    if (c.units < top) throw new ValidationError(`Something sits as high as U${top}. Move it down first, or keep the rack at least ${top}U tall`);
    this.db.prepare("UPDATE racks SET name=?, units=?, width=?, top_down=?, notes=? WHERE id=?").run(c.name, c.units, c.width, c.topDown ? 1 : 0, c.notes, id);
    return this.get(id);
  }

  removeRack(id: string): boolean {
    return tx(this.db, () => {
      this.db.prepare("DELETE FROM rack_devices WHERE rack_id = ?").run(id);
      return Number(this.db.prepare("DELETE FROM racks WHERE id = ?").run(id).changes) > 0;
    });
  }

  /** Puts racks in the given order (ids not listed keep their relative order after the listed ones). */
  order(ids: string[]): void {
    const have = (this.db.prepare("SELECT id FROM racks ORDER BY position, created_at").all() as unknown as Array<{ id: string }>).map(r => r.id);
    const next = [...ids.filter(i => have.includes(i)), ...have.filter(i => !ids.includes(i))];
    tx(this.db, () => next.forEach((id, i) => this.db.prepare("UPDATE racks SET position = ? WHERE id = ?").run(i, id)));
  }

  private cleanDevice(rack: Rack, input: unknown, old?: RackDevice) {
    const b = (input ?? {}) as Record<string, unknown>;
    const name = text(b.name ?? old?.name, 60);
    if (!name) throw new ValidationError("Give the device a name");
    const kind = String(b.kind ?? old?.kind ?? "generic");
    if (!(DEVICE_KINDS as readonly string[]).includes(kind)) throw new ValidationError("Unknown device type");
    const units = int(b.units ?? old?.units ?? 1, 1, rack.units, "The device height");
    const slot = int(b.slot ?? old?.slot ?? 1, 1, rack.units, "The position");
    if (slot + units - 1 > rack.units) throw new ValidationError(`A ${units}U device at U${slot} would stick out of the top of a ${rack.units}U rack`);
    const face = String(b.face ?? old?.face ?? "both");
    if (!["front", "rear", "both"].includes(face)) throw new ValidationError("Choose front, rear or both");
    const color = String(b.color ?? old?.color ?? "");
    if (!/^[0-6]?$/.test(color) || color === "0") throw new ValidationError("Unknown colour");
    const watts = b.watts === undefined ? old?.watts ?? null : b.watts === null || b.watts === "" ? null : int(b.watts, 0, 100000, "The power draw");
    const icon = b.icon === undefined ? old?.icon ?? "" : cleanIcon(b.icon);
    const rearIcon = b.rearIcon === undefined ? old?.rearIcon ?? "" : cleanIcon(b.rearIcon);
    const fit = String(b.fit ?? old?.fit ?? "stretch");
    const dev = {
      name, kind: kind as DeviceKind, units, slot, face: face as Face, width: (Number(b.width ?? old?.width ?? rack.width) === 10 ? 10 : 19) as 10 | 19, color,
      ports: int(b.ports ?? old?.ports ?? 0, 0, 96, "The port count"), watts, integrationId: text(b.integrationId ?? old?.integrationId ?? "", 64), notes: text(b.notes ?? old?.notes ?? "", 2000),
      icon, iconRef: icon ? (b.iconRef === undefined ? old?.iconRef ?? "" : cleanIconRef(b.iconRef)) : "", look: (b.look === undefined ? old?.look ?? "drawn" : b.look === "image" ? "image" : "drawn") as "drawn" | "image",
      rearIcon, rearIconRef: rearIcon ? (b.rearIconRef === undefined ? old?.rearIconRef ?? "" : cleanIconRef(b.rearIconRef)) : "", fit: (fit === "fit" || fit === "fill" ? fit : "stretch") as "stretch" | "fit" | "fill"
    };
    for (const other of rack.devices) {
      if (other.id === old?.id) continue;
      if (clash(dev, other)) throw new ValidationError(`That overlaps "${other.name}" (U${other.slot}${other.units > 1 ? `-${other.slot + other.units - 1}` : ""}). Pick another position, or put one of them on just the front or rear`);
    }
    return dev;
  }

  createDevice(rackId: string, input: unknown): RackDevice {
    const rack = this.get(rackId);
    if (!rack) throw new ValidationError("That rack does not exist");
    if (rack.devices.length >= 200) throw new ValidationError("A rack holds up to 200 devices");
    const d = this.cleanDevice(rack, input);
    const id = "d" + randomUUID().replace(/-/g, "").slice(0, 10);
    this.db.prepare("INSERT INTO rack_devices (id, rack_id, name, kind, units, slot, face, width, color, ports, watts, integration_id, notes, icon, icon_ref, look, rear_icon, rear_icon_ref, fit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, rackId, d.name, d.kind, d.units, d.slot, d.face, d.width, d.color, d.ports, d.watts, d.integrationId, d.notes, d.icon, d.iconRef, d.look, d.rearIcon, d.rearIconRef, d.fit, Date.now());
    return this.getDevice(id)!;
  }

  updateDevice(id: string, input: unknown): RackDevice | undefined {
    const old = this.getDevice(id);
    if (!old) return undefined;
    const rack = this.get(old.rackId)!;
    const d = this.cleanDevice(rack, input, old);
    this.db.prepare("UPDATE rack_devices SET name=?, kind=?, units=?, slot=?, face=?, width=?, color=?, ports=?, watts=?, integration_id=?, notes=?, icon=?, icon_ref=?, look=?, rear_icon=?, rear_icon_ref=?, fit=? WHERE id=?")
      .run(d.name, d.kind, d.units, d.slot, d.face, d.width, d.color, d.ports, d.watts, d.integrationId, d.notes, d.icon, d.iconRef, d.look, d.rearIcon, d.rearIconRef, d.fit, id);
    return this.getDevice(id);
  }

  removeDevice(id: string): boolean { return Number(this.db.prepare("DELETE FROM rack_devices WHERE id = ?").run(id).changes) > 0; }

  /** A connection that was deleted no longer links to anything. */
  forgetConnection(connectionId: string): void { this.db.prepare("UPDATE rack_devices SET integration_id = '' WHERE integration_id = ?").run(connectionId); }

  // ---- backup files

  exportAll(): Rack[] { return this.list(true); }

  clearAll(): void { this.db.exec("DELETE FROM rack_devices; DELETE FROM racks;"); }

  /** Adds racks from a backup file under their own ids. Anything that does not fit is skipped, never half-added. */
  importAll(racks: Rack[], skipExisting: boolean): { racks: number; devices: number } {
    const have = new Set((this.db.prepare("SELECT id FROM racks").all() as unknown as Array<{ id: string }>).map(r => r.id));
    let nr = 0, nd = 0;
    for (const r of racks) {
      if (skipExisting && have.has(r.id)) continue;
      tx(this.db, () => {
        this.db.prepare("INSERT INTO racks (id, name, units, width, top_down, notes, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(r.id, r.name, r.units, r.width, r.topDown ? 1 : 0, r.notes, r.position, Date.now());
        nr++;
        const placed: Rack = { ...r, devices: [] };
        for (const d of r.devices) {
          let clean;
          try { clean = this.cleanDevice(placed, d); } catch { continue; }
          const id = /^[A-Za-z0-9_-]{1,64}$/.test(d.id) ? d.id : "d" + randomUUID().replace(/-/g, "").slice(0, 10);
          this.db.prepare("INSERT INTO rack_devices (id, rack_id, name, kind, units, slot, face, width, color, ports, watts, integration_id, notes, icon, icon_ref, look, rear_icon, rear_icon_ref, fit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, r.id, clean.name, clean.kind, clean.units, clean.slot, clean.face, clean.width, clean.color, clean.ports, clean.watts, clean.integrationId, clean.notes, clean.icon, clean.iconRef, clean.look, clean.rearIcon, clean.rearIconRef, clean.fit, Date.now());
          placed.devices.push({ ...clean, id, rackId: r.id });
          nd++;
        }
      });
    }
    return { racks: nr, devices: nd };
  }
}

/** Shape-checks the racks inside a backup file. */
export function parseRacks(raw: unknown): Rack[] {
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  return (Array.isArray(raw) ? raw : []).slice(0, 50).filter((r: any) => ID.test(String(r?.id))).map((r: any, i: number): Rack => ({
    id: String(r.id), name: text(r.name, 60) || "Rack", units: Math.max(1, Math.min(RACK_MAX_UNITS, Math.round(Number(r.units)) || 42)), width: Number(r.width) === 10 ? 10 : 19, topDown: Boolean(r.topDown), notes: text(r.notes, 2000), position: i,
    devices: (Array.isArray(r.devices) ? r.devices : []).slice(0, 200).map((d: any): RackDevice => ({
      id: String(d?.id ?? ""), rackId: String(r.id), name: text(d?.name, 60) || "Device", kind: (DEVICE_KINDS as readonly string[]).includes(d?.kind) ? d.kind : "generic", units: Math.max(1, Math.round(Number(d?.units)) || 1), slot: Math.max(1, Math.round(Number(d?.slot)) || 1),
      face: d?.face === "front" || d?.face === "rear" ? d.face : "both", width: Number(d?.width) === 10 ? 10 : 19, color: /^[1-6]?$/.test(String(d?.color ?? "")) ? String(d?.color ?? "") : "", ports: Math.max(0, Math.min(96, Math.round(Number(d?.ports)) || 0)),
      watts: d?.watts === null || d?.watts === undefined ? null : Math.max(0, Math.round(Number(d.watts)) || 0), integrationId: text(d?.integrationId, 64), notes: text(d?.notes, 2000), icon: cleanIcon(d?.icon), iconRef: cleanIcon(d?.icon) ? cleanIconRef(d?.iconRef) : "", rearIcon: cleanIcon(d?.rearIcon), rearIconRef: cleanIcon(d?.rearIcon) ? cleanIconRef(d?.rearIconRef) : "", fit: d?.fit === "fit" || d?.fit === "fill" ? d.fit : "stretch", look: d?.look === "image" ? "image" : "drawn"
    }))
  }));
}
