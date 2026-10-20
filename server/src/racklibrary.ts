import { ValidationError } from "./dashboard.js";

/**
 * The NetBox community device library lists thousands of models with front and rear pictures. Homebase never bundles them: the server
 * looks things up on demand, and an image you pick is saved as your own copy (like any other icon you choose).
 */
const API = () => (process.env.RACK_LIBRARY_API ?? "https://api.github.com/repos/netbox-community/devicetype-library").replace(/\/+$/, "");
const RAW = () => (process.env.RACK_LIBRARY_RAW ?? "https://raw.githubusercontent.com/netbox-community/devicetype-library/master").replace(/\/+$/, "");

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

  private async bytes(path: string): Promise<Buffer> {
    let res: Response;
    try { res = await fetch(`${RAW()}/${path.split("/").map(encodeURIComponent).join("/")}`, { signal: AbortSignal.timeout(20_000) }); }
    catch { throw new ValidationError("The picture could not be downloaded. Check this server's connection to the internet."); }
    if (!res.ok) throw new ValidationError(`The picture could not be downloaded (HTTP ${res.status})`);
    if (Number(res.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) throw new ValidationError("That picture is larger than 2 MB");
    return Buffer.from(await res.arrayBuffer());
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
