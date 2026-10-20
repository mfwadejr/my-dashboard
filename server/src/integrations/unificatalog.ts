/**
 * Turns the documents a UniFi console answers into a flat list of fields you can pick from, and reads a picked field back out.
 * A path looks like  devices/f0:9f:c2:aa:bb:cc/wan1/rx_bytes-r  (source / entry / keys... / key). Arrays use their index.
 */

export type FieldUnit = "auto" | "number" | "bytesps" | "bps" | "bytes" | "percent" | "temp" | "duration" | "ms" | "mbps" | "dbm" | "bool" | "text";
export const FIELD_UNITS: readonly FieldUnit[] = ["auto", "number", "bytesps", "bps", "bytes", "percent", "temp", "duration", "ms", "mbps", "dbm", "bool", "text"];
export const SOURCES = ["health", "sysinfo", "devices", "clients"] as const;

export interface CatalogField { path: string; group: string; label: string; kind: "number" | "bool" | "text"; unit: FieldUnit; value: number | boolean | string }
export interface FieldSel { path: string; label: string; unit: FieldUnit }
export interface PickedValue { path: string; label: string; unit: FieldUnit; value: number | boolean | string | null }

/** Anything that looks like a secret never goes into the list, whatever the console puts in its answer. */
const SECRET = /(^x_)|pass|psk|secret|token|auth|key|fingerprint|hash|cert|private|credential|cookie|session|salt|anonymous|controller_id/i;
const MAX_FIELDS = 12000, MAX_PER_ENTRY = 1500, WALK_LIMIT = 20000, MAX_DEPTH = 4, MAX_ARRAY = 64;

export const humanize = (key: string): string => {
  const k = key.replace(/-r$/, "_rate").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return k.charAt(0).toUpperCase() + k.slice(1);
};

export function guessUnit(key: string, value: unknown): FieldUnit {
  const k = key.toLowerCase();
  if (typeof value === "boolean") return "bool";
  if (typeof value === "string") return "text";
  if (/^(rx|tx)_bytes-r$|bytes-r$/.test(k)) return "bytesps";
  if (/(^|_)(rx|tx)_bytes$|^bytes$|_bytes$|^(rx|tx)_total/.test(k)) return "bytes";
  if (/pct|percent|utilization|availability|usage$|^cpu$|^mem$|satisfaction|loss/.test(k)) return "percent";
  if (/temp/.test(k)) return "temp";
  if (/uptime|duration|^time_remaining|lease/.test(k)) return "duration";
  if (/latency|ping|rtt|delay/.test(k)) return "ms";
  if (/^speed$|link_speed|xput_(up|down)|_mbps$/.test(k)) return "mbps";
  if (/signal|rssi|noise|dbm/.test(k)) return "dbm";
  return "number";
}

const elementName = (el: any, index: number): string => {
  if (el && typeof el === "object") {
    const n = el.name ?? el.ifname ?? el.essid ?? el.radio ?? (el.port_idx !== undefined ? `Port ${el.port_idx}` : undefined);
    if (n !== undefined && String(n)) return String(n).slice(0, 40);
  }
  return `#${index + 1}`;
};

/** `entries` are the things under a source (devices by MAC, clients by MAC, health by name). Each has a display name. */
export function buildCatalog(sources: Record<string, Record<string, { label: string; doc: any }> | undefined>): CatalogField[] {
  const out: CatalogField[] = [];
  const titles: Record<string, (label: string) => string> = { health: l => `Site health › ${l}`, sysinfo: () => "Controller", devices: l => `Device › ${l}`, clients: l => `Client › ${l}` };
  for (const source of SOURCES) {
    const entries = sources[source];
    if (!entries) continue;
    for (const [id, entry] of Object.entries(entries)) {
      let count = 0;
      const found: Array<CatalogField & { depth: number }> = [];
      const base = titles[source](entry.label);
      const walk = (node: any, segs: string[], names: string[], depth: number) => {
        if (count >= WALK_LIMIT) return;
        if (Array.isArray(node)) {
          if (depth >= MAX_DEPTH) return;
          node.slice(0, MAX_ARRAY).forEach((el, i) => walk(el, [...segs, String(i)], [...names, elementName(el, i)], depth + 1));
          return;
        }
        if (node && typeof node === "object") {
          if (depth >= MAX_DEPTH) return;
          for (const [k, v] of Object.entries(node)) {
            if (SECRET.test(k) || k === "__label") continue;
            walk(v, [...segs, k], [...names, humanize(k)], depth + 1);
          }
          return;
        }
        const leaf = segs[segs.length - 1] ?? "";
        let value: number | boolean | string;
        if (typeof node === "number" && Number.isFinite(node)) value = node;
        else if (typeof node === "boolean") value = node;
        else if (typeof node === "string" && node.length > 0 && node.length <= 80) value = node;
        else return;
        const kind = typeof value === "number" ? "number" : typeof value === "boolean" ? "bool" : "text";
        // Array positions are named after the element they hold (a port, a radio); other keys use their own name.
        const nameOf = (i: number) => (/^\d+$/.test(segs[i]) ? names[i] : humanize(segs[i]));
        const groupParts = segs.slice(0, -1).map((_, i) => nameOf(i));
        found.push({ depth: segs.length + Math.max(0, ...segs.filter(x => /^\d+$/.test(x)).map(Number)) / 1000, path: [source, id, ...segs].join("/"), group: [base, ...groupParts].join(" › "), label: /^\d+$/.test(leaf) ? names[names.length - 1] : humanize(leaf), kind, unit: guessUnit(leaf, value), value });
        count++;
      };
      walk(entry.doc, [], [], 0);
      // Shallow values first, so a long port or radio list can never push the headline numbers (temperature, CPU) out when the entry is large.
      found.sort((a, b) => a.depth - b.depth);
      for (const f of found.slice(0, MAX_PER_ENTRY)) { if (out.length >= MAX_FIELDS) break; const { depth: _d, ...field } = f; out.push(field); }
    }
  }
  return out;
}

/** Reads one picked field out of freshly fetched documents. A missing field is null, never an error. */
export function readField(sources: Record<string, Record<string, { label: string; doc: any }> | undefined>, path: string): number | boolean | string | null {
  const [source, id, ...rest] = path.split("/");
  let cur: any = sources[source]?.[id]?.doc;
  for (const seg of rest) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : typeof cur === "boolean" ? cur : typeof cur === "string" ? cur.slice(0, 120) : null;
}

/** Checks a list sent from the browser. */
export function cleanSelection(raw: unknown): FieldSel[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldSel[] = [], seen = new Set<string>();
  for (const f of raw.slice(0, 60)) {
    const path = String(f?.path ?? "").slice(0, 240);
    const [source, id] = path.split("/");
    if (!(SOURCES as readonly string[]).includes(source) || !id || seen.has(path)) continue;
    if (path.split("/").slice(2).some(seg => SECRET.test(seg))) continue;
    seen.add(path);
    const unit = (FIELD_UNITS as readonly string[]).includes(String(f?.unit)) ? String(f.unit) as FieldUnit : "auto";
    out.push({ path, label: String(f?.label ?? "").trim().slice(0, 60) || humanize(path.split("/").pop() ?? "Value"), unit });
  }
  return out;
}
