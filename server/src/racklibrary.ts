import { ValidationError } from "./dashboard.js";

/**
 * The NetBox community device library lists thousands of models with front and rear pictures. Homebase never bundles them: the server
 * looks things up on demand, and an image you pick is saved as your own copy (like any other icon you choose).
 */
const API = () => (process.env.RACK_LIBRARY_API ?? "https://api.github.com/repos/netbox-community/devicetype-library").replace(/\/+$/, "");
const RAW = () => (process.env.RACK_LIBRARY_RAW ?? "https://raw.githubusercontent.com/netbox-community/devicetype-library/master").replace(/\/+$/, "");

const DRAW_API = () => (process.env.RACK_DRAWIO_API ?? "https://api.github.com/repos/vastoholic/draw-io").replace(/\/+$/, "");
const DRAW_RAW = () => (process.env.RACK_DRAWIO_RAW ?? "https://raw.githubusercontent.com/vastoholic/draw-io/main").replace(/\/+$/, "");
export type LibrarySource = "netbox" | "drawio";

/**
 * draw.io exports carry text labels as HTML (foreignObject) and colours as light-dark(); neither is allowed in a saved picture.
 * The labels (port numbers and the like) are dropped and the light colour is kept.
 */
export function cleanDrawio(svg: string): string {
  let out = svg.replace(/<!DOCTYPE[^>]*>/i, "").replace(/<switch>[\s\S]*?<\/switch>/g, "");
  for (let at = out.indexOf("light-dark("); at >= 0; at = out.indexOf("light-dark(", at)) {
    let depth = 0, comma = -1, end = -1;
    for (let i = at + 11; i < out.length; i++) {
      const c = out[i];
      if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) { end = i; break; } depth--; }
      else if (c === "," && depth === 0 && comma < 0) comma = i;
    }
    if (end < 0) break;
    out = out.slice(0, at) + out.slice(at + 11, comma < 0 ? end : comma).trim() + out.slice(end + 1);
  }
  return out;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,80}$/;
const IMG = /^(.+)\.(front|rear)\.(png|jpg|jpeg|webp|svg)$/i;
const HOUR = 3600_000;

export interface LibraryModel { id: string; label: string; front: string | null; rear: string | null }
export interface LibraryDetails { name: string; units: number | null; fullDepth: boolean | null; ports: number | null; front: string | null; rear: string | null }

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try { res = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "homebase" }, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new ValidationError("The device library could not be reached. Check this server's connection to the internet."); }
  if (res.status === 403 || res.status === 429) throw new ValidationError("GitHub is limiting requests from this address for now. Try again in a little while, or upload a picture instead.");
  if (!res.ok) throw new ValidationError(`The device library answered with an error (HTTP ${res.status})`);
  try { return await res.json(); } catch { throw new ValidationError("The device library sent something Homebase could not read"); }
}

export class RackLibrary {
  private cache = new Map<string, { at: number; value: unknown }>();

  private async listing(path: string): Promise<Array<{ name: string; type: string }>> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < 6 * HOUR) return hit.value as Array<{ name: string; type: string }>;
    const doc = await getJson(`${API()}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
    if (!Array.isArray(doc)) throw new ValidationError("That part of the device library does not exist");
    const items = doc.filter(x => x && typeof x.name === "string").map(x => ({ name: String(x.name), type: String(x.type ?? "file") }));
    this.cache.set(path, { at: Date.now(), value: items });
    return items;
  }

  private async tree(): Promise<string[]> {
    const hit = this.cache.get("drawio-tree");
    if (hit && Date.now() - hit.at < 6 * HOUR) return hit.value as string[];
    const doc = await getJson(`${DRAW_API()}/git/trees/main?recursive=1`) as { tree?: Array<{ path?: string; type?: string }> };
    if (!Array.isArray(doc?.tree)) throw new ValidationError("The UniFi drawings could not be listed");
    const files = doc.tree.filter(x => x?.type === "blob" && typeof x.path === "string" && /^SVG Files\/[^/]+\/.+\.svg$/i.test(x.path)).map(x => x.path!.slice("SVG Files/".length));
    this.cache.set("drawio-tree", { at: Date.now(), value: files });
    return files;
  }

  async drawioManufacturers(): Promise<string[]> {
    return [...new Set((await this.tree()).map(f => f.split("/")[0]))].sort((a, b) => a.localeCompare(b));
  }

  /** Drawings of one folder, as path-like ids ("Switches/Professional/USW-Pro-24-PoE"). */
  async drawioModels(manufacturer: string, q = ""): Promise<LibraryModel[]> {
    const words = q.toLowerCase().split(/[\s/_-]+/).filter(Boolean);
    return (await this.tree()).filter(f => f.startsWith(`${manufacturer}/`)).map(f => f.slice(manufacturer.length + 1, -4))
      .filter(id => words.every(w => id.toLowerCase().includes(w))).sort((a, b) => a.localeCompare(b)).slice(0, 300)
      .map(id => ({ id, label: id, front: id, rear: null }));
  }

  async drawioFetch(manufacturer: string, model: string): Promise<{ details: LibraryDetails; front: Buffer | null; rear: Buffer | null }> {
    const path = `${manufacturer}/${model}.svg`;
    if (!(await this.tree()).includes(path)) throw new ValidationError("That drawing is not in the library");
    const raw = await this.bytes(`SVG Files/${path}`, DRAW_RAW(), 6 * 1024 * 1024);
    const text = raw.toString("utf8");
    // A rack-width drawing (the 1U ones are about 11 times wider than tall) tells us the height in rack units.
    const m = /<svg[^>]*\swidth="([0-9.]+)px"[^>]*\sheight="([0-9.]+)px"/.exec(text);
    const ratio = m ? Number(m[1]) / Number(m[2]) : 0;
    const units = ratio > 4 && ratio < 14 ? Math.max(1, Math.round((10.86 / ratio))) : null;
    const name = model.split("/").pop()!.replace(/\s*\(.*?\)\s*$/, "").replace(/[-_]+/g, " ").trim();
    return { details: { name, units, fullDepth: null, ports: null, front: model, rear: null }, front: Buffer.from(cleanDrawio(text)), rear: null };
  }

  async manufacturers(): Promise<string[]> {
    return (await this.listing("elevation-images")).filter(x => x.type === "dir" && NAME.test(x.name)).map(x => x.name).sort((a, b) => a.localeCompare(b));
  }

  /** Models of one manufacturer that have a picture, matching `q` when given. */
  async models(manufacturer: string, q = ""): Promise<LibraryModel[]> {
    if (!NAME.test(manufacturer)) throw new ValidationError("Unknown manufacturer");
    const files = await this.listing(`elevation-images/${manufacturer}`);
    const byId = new Map<string, LibraryModel>();
    for (const f of files) {
      const m = IMG.exec(f.name);
      if (!m || f.type === "dir") continue;
      const m0 = byId.get(m[1]) ?? { id: m[1], label: m[1].replace(/[-_]+/g, " "), front: null, rear: null };
      m0[m[2].toLowerCase() as "front" | "rear"] = f.name;
      byId.set(m[1], m0);
    }
    const words = q.toLowerCase().split(/[\s-_]+/).filter(Boolean);
    return [...byId.values()].filter(x => words.every(w => `${x.id} ${x.label}`.toLowerCase().includes(w))).sort((a, b) => a.label.localeCompare(b.label)).slice(0, 200);
  }

  private async bytes(path: string, base = RAW(), limit = 2 * 1024 * 1024): Promise<Buffer> {
    let res: Response;
    try { res = await fetch(`${base}/${path.split("/").map(encodeURIComponent).join("/")}`, { signal: AbortSignal.timeout(20_000) }); }
    catch { throw new ValidationError("The picture could not be downloaded. Check this server's connection to the internet."); }
    if (!res.ok) throw new ValidationError(`The picture could not be downloaded (HTTP ${res.status})`);
    if (Number(res.headers.get("content-length") ?? 0) > limit) throw new ValidationError("That picture is too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new ValidationError("That picture is too large");
    return buf;
  }

  /** The front and rear pictures (as bytes) and, when the library describes the model, its height, depth and port count. */
  async fetch(manufacturer: string, model: string): Promise<{ details: LibraryDetails; front: Buffer | null; rear: Buffer | null }> {
    if (!NAME.test(manufacturer) || !NAME.test(model)) throw new ValidationError("Unknown model");
    const found = (await this.models(manufacturer, "")).find(x => x.id === model);
    if (!found) throw new ValidationError("That model has no picture in the library");
    const [front, rear] = await Promise.all([found.front, found.rear].map(f => (f ? this.bytes(`elevation-images/${manufacturer}/${f}`).catch(() => null) : Promise.resolve(null))));
    let units: number | null = null, fullDepth: boolean | null = null, ports: number | null = null, name = found.label;
    try {
      const yaml = (await this.bytes(`device-types/${manufacturer}/${model}.yaml`)).toString("utf8");
      units = Number(/^u_height:\s*([0-9.]+)/m.exec(yaml)?.[1]) || null;
      if (units !== null) units = Math.max(1, Math.round(units));
      const depth = /^is_full_depth:\s*(\w+)/im.exec(yaml)?.[1];
      fullDepth = depth ? /^(true|yes)$/i.test(depth) : null;
      const label = /^model:\s*['"]?(.+?)['"]?\s*$/m.exec(yaml)?.[1];
      if (label) name = label;
      const block = /^interfaces:\s*\n((?:[ \t-].*\n?)*)/m.exec(yaml)?.[1];
      if (block) { const n = (block.match(/^\s*-\s*name:/gm) ?? []).length; ports = n > 0 ? n : null; }
    } catch { /* the pictures are what matters; size and ports are a convenience */ }
    return { details: { name, units, fullDepth, ports, front: found.front, rear: found.rear }, front, rear };
  }
}
