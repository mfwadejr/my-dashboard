import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const INDEX_URL = "https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/metadata.json";
const CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
const MAX_BYTES = 2 * 1024 * 1024;
const WEEK = 7 * 86400_000;

export interface IconHit { ref: string; label: string; preview: string }

/** Detect the real image type from the first bytes, not from the filename or header the sender claims. */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return { ext: "gif", mime: "image/gif" };
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { ext: "webp", mime: "image/webp" };
  const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if ((head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype svg")) && buf.toString("utf8").toLowerCase().includes("<svg")) return { ext: "svg", mime: "image/svg+xml" };
  return null;
}

export class Icons {
  private index: Array<{ slug: string; aliases: string[] }> | null = null;
  readonly dir: string;
  constructor(private dataDir: string) {
    this.dir = join(dataDir, "icons");
    mkdirSync(this.dir, { recursive: true });
  }

  private async loadIndex(): Promise<Array<{ slug: string; aliases: string[] }>> {
    if (this.index) return this.index;
    const cache = join(this.dataDir, "icons-index.json");
    if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < WEEK) {
      this.index = JSON.parse(readFileSync(cache, "utf8"));
      return this.index!;
    }
    try {
      const res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = (await res.json()) as Record<string, { aliases?: string[] }>;
      this.index = Object.entries(doc).map(([slug, meta]) => ({ slug, aliases: meta.aliases ?? [] }));
      writeFileSync(cache, JSON.stringify(this.index));
    } catch (error) {
      if (existsSync(cache)) { this.index = JSON.parse(readFileSync(cache, "utf8")); return this.index!; }
      throw new Error(`Could not load the icon library: ${error instanceof Error ? error.message : error}`);
    }
    return this.index!;
  }

  async search(query: string): Promise<IconHit[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const hits = (await this.loadIndex()).filter(i => i.slug.includes(q) || i.aliases.some(a => a.toLowerCase().includes(q)));
    hits.sort((a, b) => Number(b.slug.startsWith(q)) - Number(a.slug.startsWith(q)) || a.slug.length - b.slug.length);
    return hits.slice(0, 40).map(i => ({ ref: `di:${i.slug}`, label: i.slug.replace(/-/g, " "), preview: `${CDN}/svg/${i.slug}.svg` }));
  }

  /** Save image bytes locally under a content-hash name and return the stored id. */
  save(buf: Buffer): string {
    if (buf.length > MAX_BYTES) throw new Error("Icons must be 2 MB or smaller");
    const kind = sniffImage(buf);
    if (!kind) throw new Error("That file is not a PNG, JPEG, GIF, WebP or SVG image");
    const id = `${createHash("sha256").update(buf).digest("hex").slice(0, 24)}.${kind.ext}`;
    const file = join(this.dir, id);
    if (!existsSync(file)) writeFileSync(file, buf);
    return id;
  }

  /** Download a library icon (by ref "di:slug") or an https image URL into local storage. */
  async mirror(refOrUrl: string): Promise<string> {
    let url: string;
    if (refOrUrl.startsWith("di:")) {
      const slug = refOrUrl.slice(3);
      if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug)) throw new Error("Invalid icon name");
      url = `${CDN}/svg/${slug}.svg`;
    } else {
      let parsed: URL;
      try { parsed = new URL(refOrUrl); } catch { throw new Error("Enter a valid https:// image address"); }
      if (parsed.protocol !== "https:") throw new Error("Use an https:// image address");
      url = parsed.toString();
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Could not download the icon (HTTP ${res.status})`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error("Icons must be 2 MB or smaller");
    return this.save(Buffer.from(await res.arrayBuffer()));
  }

  path(id: string): string | null {
    if (!/^[a-f0-9]{24}\.(png|jpg|gif|webp|svg)$/.test(id)) return null;
    const file = join(this.dir, id);
    return existsSync(file) ? file : null;
  }
}
