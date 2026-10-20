import type { IntegrationInfo, RackDeviceInfo, RackFace, RackInfo, RackKind, Snapshot } from "../types";

export const KINDS: Array<{ id: RackKind; label: string; unit: string; ports: number; units: number }> = [
  { id: "switch", label: "Network switch", unit: "ports", ports: 24, units: 1 },
  { id: "router", label: "Router or firewall", unit: "ports", ports: 8, units: 1 },
  { id: "patch", label: "Patch panel", unit: "ports", ports: 24, units: 1 },
  { id: "server", label: "Server", unit: "drive bays", ports: 8, units: 2 },
  { id: "nas", label: "Storage (NAS)", unit: "drive bays", ports: 4, units: 2 },
  { id: "pdu", label: "Power strip (PDU)", unit: "outlets", ports: 8, units: 1 },
  { id: "ups", label: "UPS", unit: "", ports: 0, units: 2 },
  { id: "shelf", label: "Shelf", unit: "", ports: 0, units: 1 },
  { id: "blank", label: "Blanking panel", unit: "", ports: 0, units: 1 },
  { id: "cable", label: "Cable management", unit: "", ports: 0, units: 1 },
  { id: "generic", label: "Other equipment", unit: "", ports: 0, units: 1 }
];
export const kindInfo = (k: RackKind) => KINDS.find(x => x.id === k) ?? KINDS[KINDS.length - 1];
export const FACES: Array<{ id: RackFace; label: string }> = [
  { id: "both", label: "Full depth (front and rear)" }, { id: "front", label: "Front only (half depth)" }, { id: "rear", label: "Rear only (half depth)" }
];

/** The unit number shown on the rack for position `p` counted from the bottom (and back: the mapping is its own inverse for a device's lowest unit). */
export const unitLabel = (rack: Pick<RackInfo, "units" | "topDown">, fromBottom: number) => (rack.topDown ? rack.units - fromBottom + 1 : fromBottom);

/** Position as people type it: the lowest number the device covers on the rack's own numbering. Converts to and from the stored slot. */
export const toTyped = (rack: Pick<RackInfo, "units" | "topDown">, slot: number, units: number) => (rack.topDown ? rack.units - slot - units + 2 : slot);
export const fromTyped = (rack: Pick<RackInfo, "units" | "topDown">, typed: number, units: number) => (rack.topDown ? rack.units - typed - units + 2 : typed);

export const rangeText = (rack: Pick<RackInfo, "units" | "topDown">, d: Pick<RackDeviceInfo, "slot" | "units">) => {
  const a = toTyped(rack, d.slot, d.units), b = a + d.units - 1;
  return d.units === 1 ? `U${a}` : `U${a}–U${b}`;
};

const faces = (f: RackFace) => (f === "both" ? ["front", "rear"] : [f]);
export const clashes = (a: { slot: number; units: number; face: RackFace }, b: { slot: number; units: number; face: RackFace }) =>
  a.slot < b.slot + b.units && b.slot < a.slot + a.units && faces(a.face).some(f => faces(b.face).includes(f));

export const onFace = (d: Pick<RackDeviceInfo, "face">, view: "front" | "rear") => d.face === "both" || d.face === view;

/** What a linked connection says about a device right now. */
export type Live = { state: "up" | "down" | "none"; name: string; watts: number | null };
export function liveOf(d: RackDeviceInfo, integrations: IntegrationInfo[], snaps: Record<string, Snapshot>): Live {
  if (!d.integrationId) return { state: "none", name: "", watts: null };
  const info = integrations.find(i => i.id === d.integrationId);
  if (!info) return { state: "none", name: "", watts: null };
  const snap = snaps[d.integrationId];
  const pdus = Array.isArray(snap?.data?.pdus) ? snap.data.pdus as Array<{ name?: string; totalW?: number }> : [];
  let watts: number | null = null;
  if (snap?.ok && d.kind === "pdu" && pdus.length) {
    const own = pdus.find(p => String(p.name ?? "").toLowerCase() === d.name.toLowerCase()) ?? (pdus.length === 1 ? pdus[0] : undefined);
    const list = own ? [own] : pdus;
    const sum = list.reduce((n, p) => n + (typeof p.totalW === "number" ? p.totalW : 0), 0);
    watts = list.some(p => typeof p.totalW === "number") ? Math.round(sum) : null;
  }
  return { state: !snap ? "none" : snap.ok ? "up" : "down", name: info.name, watts };
}

/**
 * A rack's power. A linked power strip measures everything plugged into it, so when any strip reports live watts those readings are the
 * total. Otherwise the typical draws typed on the devices are added up. Mixing the two would count the same equipment twice.
 */
export function powerOf(rack: RackInfo, integrations: IntegrationInfo[], snaps: Record<string, Snapshot>): { watts: number | null; source: "live" | "typed" | "none"; offline: number } {
  const lives = rack.devices.map(d => ({ d, live: liveOf(d, integrations, snaps) }));
  const measured = lives.filter(x => x.live.watts !== null);
  const offline = lives.filter(x => x.live.state === "down").length;
  if (measured.length) return { watts: measured.reduce((n, x) => n + (x.live.watts ?? 0), 0), source: "live", offline };
  const typed = rack.devices.filter(d => d.watts !== null);
  if (typed.length) return { watts: typed.reduce((n, d) => n + (d.watts ?? 0), 0), source: "typed", offline };
  return { watts: null, source: "none", offline };
}

export const usedUnits = (rack: RackInfo) => {
  const taken = new Set<number>();
  for (const d of rack.devices) for (let u = d.slot; u < d.slot + d.units; u++) taken.add(u);
  return taken.size;
};
