import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getMeta, logEvent, setMeta, tx, type DB } from "./db.js";
import { getSettings } from "./settings.js";
import { readTarGz } from "./tarstream.js";

export const ICON_SOURCES = ["dashboard-icons", "selfhst", "lucide"] as const;
export type IconSource = typeof ICON_SOURCES[number];
export const SOURCE_NAMES: Record<IconSource, string> = { "dashboard-icons": "Dashboard Icons", selfhst: "selfh.st Icons", lucide: "Lucide symbols" };
export const ICON_TIERS = ["search", "cached", "mirror-single", "mirror-full"] as const;
export type IconTier = typeof ICON_TIERS[number];

const MAX_IMAGE = 2 * 1024 * 1024, MAX_SVG = 512 * 1024, CACHE_CAP = 200 * 1024 * 1024, DAY = 86400_000;
const LIBRARY_FORMATS = ["svg", "png", "webp"] as const;
const FORMAT_RANK: Record<string, number> = { svg: 0, png: 1, webp: 2 };
const LUCIDE_COLOR = "#c7d0de";
const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/;

export interface IconHit { ref: string; label: string; source: IconSource; sourceName: string; preview: string }
interface IndexRow { source: IconSource; slug: string; format: string; formats: string; label: string; search_text: string; content_hash: string; mirrored: number; removed_at: number | null; synced_at: number }
export interface IndexEntry { slug: string; format: string; formats: string[]; label: string; searchText: string }

/** Where each source's files come from. Replaced in tests (and by ICON_SOURCE_BASE) so no real network is needed. */
export interface IconUrls {
  assets(source: IconSource, slug: string, format: string): string[];
  index(source: IconSource): string | null;
  tarball(source: IconSource): Promise<string>;
}
const REPO: Record<IconSource, string> = { "dashboard-icons": "homarr-labs/dashboard-icons", selfhst: "selfhst/icons", lucide: "lucide-icons/lucide" };
export function defaultUrls(base = process.env.ICON_SOURCE_BASE): IconUrls {
  if (base) {
    const b = base.replace(/\/+$/, "");
    return { assets: (s, slug, f) => [`${b}/${s}/${f}/${slug}.${f}`], index: s => (s === "lucide" ? null : `${b}/${s}/index.json`), tarball: async s => `${b}/${s}.tar.gz` };
  }
  return {
    assets: (s, slug, f) => s === "lucide"
      ? [`https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/${slug}.svg`, `https://cdn.jsdelivr.net/npm/lucide-static/icons/${slug}.svg`]
      : [`https://raw.githubusercontent.com/${REPO[s]}/main/${f}/${slug}.${f}`, `https://cdn.jsdelivr.net/gh/${REPO[s]}/${f}/${slug}.${f}`],
    index: s => (s === "dashboard-icons" ? "https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/metadata.json" : s === "selfhst" ? "https://raw.githubusercontent.com/selfhst/icons/main/index.json" : null),
    tarball: async s => {
      if (s !== "lucide") return `https://codeload.github.com/${REPO[s]}/tar.gz/refs/heads/main`;
      // Lucide's own repository is large; its npm package carries exactly the icons and their tags.
      const res = await fetch("https://registry.npmjs.org/lucide-static/latest", { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`The npm registry answered ${res.status}`);
      const url = ((await res.json()) as { dist?: { tarball?: string } }).dist?.tarball;
      if (!url) throw new Error("The npm registry did not say where the Lucide icons are");
      return url;
    }
  };
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const iconLabel = (slug: string) => slug.split("-").map(w => (w ? w[0].toUpperCase() + w.slice(1) : "")).join(" ");
const norm = (...parts: Array<string | undefined>) => [...new Set(parts.filter(Boolean).join(" ").toLowerCase().split(/[\s,]+/).filter(Boolean))].join(" ");

/** Detect the real image type from the first bytes, not from the filename or header the sender claims. */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return { ext: "gif", mime: "image/gif" };
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { ext: "webp", mime: "image/webp" };
  const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if ((head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype svg") || head.startsWith("<!--")) && buf.toString("utf8").toLowerCase().includes("<svg")) return { ext: "svg", mime: "image/svg+xml" };
  return null;
}

/** An SVG may not run anything or reach out to other sites. */
export function svgIsSafe(svg: string): boolean {
  return svg.length <= MAX_SVG && /<svg[\s>]/i.test(svg) && !/<(?:script|foreignObject|iframe|embed|object)\b|<!ENTITY|\son\w+\s*=|javascript:|(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|data:text)/i.test(svg);
}

/** Checks image bytes from anywhere. Throws a plain sentence when they are not acceptable. */
export function checkImage(buf: Buffer, allowed: readonly string[]): { ext: string; mime: string; buf: Buffer } {
  if (buf.length > MAX_IMAGE) throw new Error("Icons must be 2 MB or smaller");
  const kind = sniffImage(buf);
  if (!kind || !allowed.includes(kind.ext)) throw new Error(allowed.includes("gif") ? "That file is not a PNG, JPEG, GIF, WebP or SVG image" : "That image is not a type Homebase accepts");
  if (kind.ext === "svg" && !svgIsSafe(buf.toString("utf8"))) throw new Error("That SVG did not pass the safety check (it contains scripts or links to other sites)");
  return { ...kind, buf };
}
const recolorLucide = (b: Buffer) => Buffer.from(b.toString("utf8").replace(/currentColor/g, LUCIDE_COLOR), "utf8");

// ---- what the libraries publish (pure, so they can be tested)

export function parseDashboardIcons(doc: unknown): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const [slug, raw] of Object.entries((doc ?? {}) as Record<string, { base?: string; aliases?: string[]; categories?: string[] }>)) {
    if (!SLUG.test(slug)) continue;
    const base = raw?.base === "png" || raw?.base === "webp" ? raw.base : "svg";
    const formats = base === "svg" ? ["svg", "png", "webp"] : ["png", "webp"];
    out.push({ slug, format: base, formats, label: iconLabel(slug), searchText: norm(slug, slug.replace(/-/g, " "), ...(raw?.aliases ?? []), ...(raw?.categories ?? [])) });
  }
  return out;
}

const yes = (v: unknown) => /^(y|yes|true|1)$/i.test(String(v ?? "").trim());
export function parseSelfhst(doc: unknown): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const raw of Array.isArray(doc) ? doc : []) {
    const slug = String(raw?.Reference ?? "").toLowerCase();
    if (!SLUG.test(slug)) continue;
    let formats = [yes(raw.SVG) && "svg", yes(raw.PNG) && "png", yes(raw.WebP) && "webp"].filter(Boolean) as string[];
    if (!formats.length) formats = ["svg", "png", "webp"];
    const label = String(raw.Name || iconLabel(slug)).slice(0, 80);
    out.push({ slug, format: formats[0], formats, label, searchText: norm(slug, slug.replace(/-/g, " "), label, String(raw.Category ?? ""), String(raw.Tags ?? "")) });
  }
  return out;
}

export function parseLucide(slugs: string[], tags: Record<string, string[]>): IndexEntry[] {
  return slugs.filter(s => SLUG.test(s)).map(slug => ({ slug, format: "svg", formats: ["svg"], label: iconLabel(slug), searchText: norm(slug, slug.replace(/-/g, " "), ...(tags[slug] ?? [])) }));
}

// ---- values stored on things

/** The value kept on a tab, tile, connection and so on: empty, a saved file, or (older installs) a flat file id. */
export const ICON_VALUE = /^(?:used\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:svg|png|jpg|gif|webp)(?:\?v=[0-9a-f]{6,64})?|[a-f0-9]{24}\.(?:png|jpg|gif|webp|svg))$/;
export const ICON_REF = /^(?:dashboard-icons|selfhst|lucide):[a-z0-9][a-z0-9-]{0,100}$/;
export const cleanIcon = (v: unknown): string => (typeof v === "string" && ICON_VALUE.test(v) ? v : "");
export const cleanIconRef = (v: unknown): string => (typeof v === "string" && ICON_REF.test(v) ? v : "");
export const parseRef = (ref: string): { source: IconSource; slug: string } | null => {
  if (!ICON_REF.test(ref)) return null;
  const i = ref.indexOf(":");
  return { source: ref.slice(0, i) as IconSource, slug: ref.slice(i + 1) };
};
/** The file part of a value, without the cache-busting suffix. */
export const iconFile = (v: string): string => v.split("?")[0];
export const iconHash = (v: string): string => /[?&]v=([0-9a-f]+)/.exec(v)?.[1] ?? "";

export interface SourceState { status: "idle" | "queued" | "running" | "error"; error: string | null; indexAt: number | null; mirrorAt: number | null; progress: number }

export class Icons {
  readonly dir: string; readonly usedDir: string; readonly mirrorDir: string; readonly cacheDir: string;
  private jobs = {} as Record<IconSource, SourceState>;
  private chain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout; private first?: NodeJS.Timeout;
  private cacheBytes: number | null = null;
  private sizeMemo: { at: number; v: { mirror: number; cache: number; used: number } } | null = null;

  constructor(private db: DB, dataDir: string, private urls: IconUrls = defaultUrls()) {
    this.dir = join(dataDir, "icons");
    this.usedDir = join(this.dir, "used"); this.mirrorDir = join(this.dir, "mirror"); this.cacheDir = join(this.dir, "cache");
    mkdirSync(this.usedDir, { recursive: true });
    const saved = this.saved();
    for (const s of ICON_SOURCES) this.jobs[s] = { status: "idle", error: saved[s]?.error ?? null, indexAt: saved[s]?.indexAt ?? null, mirrorAt: saved[s]?.mirrorAt ?? null, progress: 0 };
  }

  // ---- settings and saved status

  tier(): IconTier { return getSettings(this.db).iconTier; }
  reviewed(): boolean { return getSettings(this.db).iconReviewed; }
  private mirrorTier = () => this.tier() === "mirror-single" || this.tier() === "mirror-full";
  private saved(): Partial<Record<IconSource, { indexAt: number | null; mirrorAt: number | null; error: string | null }>> { try { return JSON.parse(getMeta(this.db, "icon_sync") ?? "{}"); } catch { return {}; } }
  private persist(): void { setMeta(this.db, "icon_sync", JSON.stringify(Object.fromEntries(ICON_SOURCES.map(s => [s, { indexAt: this.jobs[s].indexAt, mirrorAt: this.jobs[s].mirrorAt, error: this.jobs[s].error }])))); }

  // ---- served files

  /** Where a saved icon of this name ("used/...") lives on disk, whether or not it exists yet. Only names that pass the pattern get a path. */
  usedPath(name: string): string {
    if (!/^used\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:svg|png|jpg|gif|webp)$/.test(name)) throw new Error("Invalid icon name");
    return join(this.dir, name);
  }

  /** A saved icon file (or an older flat one) by the value stored on a thing. Null when it is not a file we hold. */
  file(value: string): string | null {
    const v = iconFile(value);
    if (!ICON_VALUE.test(v)) return null;
    const p = join(this.dir, v);
    return existsSync(p) ? p : null;
  }

  // ---- search

  row(source: IconSource, slug: string): IndexRow | undefined {
    return this.db.prepare("SELECT * FROM icon_index WHERE source = ? AND slug = ?").get(source, slug) as IndexRow | undefined;
  }

  ready(): boolean { return (this.db.prepare("SELECT COUNT(*) AS n FROM icon_index WHERE removed_at IS NULL").get() as { n: number }).n > 0; }

  search(query: string, limit = 60): IconHit[] {
    const q = query.trim().toLowerCase().slice(0, 80);
    if (q.length < 2) return [];
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 5);
    const like = (t: string) => `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const where = tokens.map(() => "(search_text LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\')").join(" AND ");
    const rows = this.db.prepare(`SELECT source, slug, format, label, content_hash FROM icon_index WHERE removed_at IS NULL AND ${where}`)
      .all(...tokens.flatMap(t => [like(t), like(t)])) as unknown as IndexRow[];
    const rank = (s: string) => ICON_SOURCES.indexOf(s as IconSource);
    rows.sort((a, b) => rank(a.source) - rank(b.source));
    // The same app often appears in both app-logo libraries; keep the first. Symbols are a different look, so they all stay.
    const seen = new Set<string>(), kept: IndexRow[] = [];
    for (const r of rows) { if (r.source !== "lucide") { if (seen.has(r.slug)) continue; seen.add(r.slug); } kept.push(r); }
    // Light/dark background variants (plex-dark, plex-light) bury the icon most searches want; they stay reachable by their exact name.
    const shown = kept.filter(r => r.source === "lucide" || r.slug === q || !/-(?:light|dark)$/i.test(r.slug));
    const score = (r: IndexRow) => (r.slug === q ? 0 : r.slug.startsWith(q) ? 1 : r.label.toLowerCase().startsWith(q) ? 2 : r.slug.includes(q) ? 3 : 4);
    shown.sort((a, b) => score(a) - score(b) || a.slug.length - b.slug.length || a.slug.localeCompare(b.slug));
    return shown.slice(0, limit).map(r => ({ ref: `${r.source}:${r.slug}`, label: r.label || iconLabel(r.slug), source: r.source, sourceName: SOURCE_NAMES[r.source], preview: `/api/icons/preview/${r.source}/${r.slug}${r.content_hash ? `?v=${r.content_hash.slice(0, 10)}` : ""}` }));
  }

  // ---- getting one library icon's bytes: local mirror, local cache, then the source

  private formatOrder(source: IconSource, slug: string): string[] {
    const r = this.row(source, slug);
    const listed = r ? r.formats.split(",").filter(Boolean) : [];
    const first = r?.format ?? "";
    const all = [first, ...listed, ...LIBRARY_FORMATS].filter((f, i, a) => f && a.indexOf(f) === i && (source !== "lucide" || f === "svg"));
    return all;
  }

  private async fetchBytes(url: string, timeout = 8000): Promise<Buffer | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) return null;
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_IMAGE) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch { return null; }
  }

  /** One library icon, checked and (for Lucide) recolored for the dark theme. */
  async bytes(source: IconSource, slug: string, opts: { fresh?: boolean; store?: boolean } = {}): Promise<{ buf: Buffer; ext: string; mime: string; from: "mirror" | "cache" | "source" } | null> {
    if (!SLUG.test(slug)) return null;
    const order = this.formatOrder(source, slug);
    if (!opts.fresh) {
      for (const f of order) {
        for (const [dir, from] of [[this.mirrorDir, "mirror"], [this.cacheDir, "cache"]] as const) {
          const p = join(dir, source, ...(from === "mirror" ? [f] : []), `${slug}.${f}`);
          if (!existsSync(p)) continue;
          try { const buf = readFileSync(p); const k = checkImage(buf, LIBRARY_FORMATS); if (from === "cache") { try { const now = new Date(); utimesSync(p, now, now); } catch { /* order only */ } } return { ...k, from }; } catch { /* damaged copy: look further */ }
        }
      }
    } else if (this.mirrorTier()) {
      // A mirror is refreshed daily, so it is as fresh as anything we could fetch right now.
      for (const f of order) { const p = join(this.mirrorDir, source, f, `${slug}.${f}`); if (existsSync(p)) { try { return { ...checkImage(readFileSync(p), LIBRARY_FORMATS), from: "mirror" }; } catch { /* fall through */ } } }
    }
    for (const f of order) {
      for (const url of this.urls.assets(source, slug, f)) {
        let buf = await this.fetchBytes(url);
        if (!buf) continue;
        try {
          if (source === "lucide") buf = recolorLucide(buf);
          const k = checkImage(buf, LIBRARY_FORMATS);
          if (opts.store && this.tier() !== "search") this.cachePut(source, slug, k.ext, k.buf);
          return { ...k, from: "source" };
        } catch { /* wrong or unsafe: try the next address or format */ }
      }
    }
    return null;
  }

  async preview(source: IconSource, slug: string): Promise<{ buf: Buffer; mime: string } | null> {
    const r = await this.bytes(source, slug, { store: true });
    return r ? { buf: r.buf, mime: r.mime } : null;
  }

  private cachePut(source: IconSource, slug: string, ext: string, buf: Buffer): void {
    try {
      const dir = join(this.cacheDir, source);
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${slug}.${ext}`), part = `${p}.part`;
      writeFileSync(part, buf); renameSync(part, p);
      this.cacheBytes = (this.cacheBytes ?? this.scan(this.cacheDir)) + buf.length;
      if (this.cacheBytes > CACHE_CAP) this.pruneCache();
    } catch { /* the cache is an optimisation only */ }
  }

  private list(dir: string): Array<{ path: string; size: number; mtime: number }> {
    const out: Array<{ path: string; size: number; mtime: number }> = [];
    const walk = (d: string) => { let names: string[] = []; try { names = readdirSync(d); } catch { return; } for (const n of names) { const p = join(d, n); try { const st = statSync(p); if (st.isDirectory()) walk(p); else out.push({ path: p, size: st.size, mtime: st.mtimeMs }); } catch { /* vanished */ } } };
    walk(dir);
    return out;
  }
  private scan(dir: string): number { return this.list(dir).reduce((n, f) => n + f.size, 0); }

  /** Oldest cached previews go first, down to 80% of the cap. */
  pruneCache(cap = CACHE_CAP): number {
    const files = this.list(this.cacheDir).sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((n, f) => n + f.size, 0), removed = 0;
    for (const f of files) { if (total <= cap * 0.8) break; try { rmSync(f.path); total -= f.size; removed++; } catch { /* ignore */ } }
    this.cacheBytes = total;
    return removed;
  }

  sizes(): { mirror: number; cache: number; used: number } {
    if (this.sizeMemo && Date.now() - this.sizeMemo.at < 30_000) return this.sizeMemo.v;
    const v = { mirror: this.scan(this.mirrorDir), cache: this.scan(this.cacheDir), used: this.scan(this.usedDir) };
    this.cacheBytes = v.cache; this.sizeMemo = { at: Date.now(), v };
    return v;
  }

  // ---- saving an icon on something: a frozen copy in icons/used

  private writeUsed(name: string, buf: Buffer): string {
    mkdirSync(this.usedDir, { recursive: true });
    const p = join(this.usedDir, name), part = `${p}.part`;
    writeFileSync(part, buf); renameSync(part, p);
    this.sizeMemo = null;
    return `used/${name}?v=${sha(buf).slice(0, 10)}`;
  }

  /** Saves a library icon as its own copy. It never changes by itself afterwards; "update available" offers a refresh. */
  async freeze(ref: string, opts: { fresh?: boolean } = {}): Promise<{ icon: string; iconRef: string }> {
    const parsed = parseRef(ref);
    if (!parsed) throw new Error("That is not a valid icon choice");
    const got = await this.bytes(parsed.source, parsed.slug, { fresh: opts.fresh });
    if (!got) throw new Error("That icon could not be downloaded. Check the connection to the internet, or pick another.");
    return { icon: this.writeUsed(`${parsed.source}-${parsed.slug}.${got.ext}`, got.buf), iconRef: ref };
  }

  freezeUpload(buf: Buffer): { icon: string; iconRef: string } {
    const k = checkImage(buf, ["png", "jpg", "gif", "webp", "svg"]);
    return { icon: this.writeUsed(`upload-${sha(buf).slice(0, 24)}.${k.ext}`, k.buf), iconRef: "" };
  }

  async freezeUrl(url: string): Promise<{ icon: string; iconRef: string }> {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error("Enter a valid https:// image address"); }
    if (u.protocol !== "https:") throw new Error("Use an https:// image address");
    let res: Response;
    try { res = await fetch(u, { signal: AbortSignal.timeout(15_000) }); } catch { throw new Error("That address could not be reached"); }
    if (!res.ok) throw new Error(`Could not download the icon (HTTP ${res.status})`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE) throw new Error("Icons must be 2 MB or smaller");
    return this.freezeUpload(Buffer.from(await res.arrayBuffer()));
  }

  /** Removes saved files nothing uses any more. Files younger than `graceMs` stay, since they may be about to be assigned. */
  gc(used: Set<string>, graceMs = 10 * 60_000): number {
    let removed = 0;
    for (const f of this.list(this.usedDir)) {
      const name = `used/${f.path.split("/").pop()}`;
      if (used.has(name) || Date.now() - f.mtime < graceMs) continue;
      try { rmSync(f.path); removed++; } catch { /* ignore */ }
    }
    if (removed) this.sizeMemo = null;
    return removed;
  }

  // ---- keeping the library list and mirror current

  state(): Record<IconSource, SourceState> { return this.jobs; }

  counts(): Record<IconSource, { indexed: number; mirrored: number; removed: number }> {
    const out = {} as Record<IconSource, { indexed: number; mirrored: number; removed: number }>;
    for (const s of ICON_SOURCES) out[s] = { indexed: 0, mirrored: 0, removed: 0 };
    for (const r of this.db.prepare("SELECT source, COUNT(*) AS n, SUM(mirrored) AS m, SUM(removed_at IS NOT NULL) AS x FROM icon_index GROUP BY source").all() as unknown as Array<{ source: IconSource; n: number; m: number | null; x: number | null }>) {
      if (out[r.source]) out[r.source] = { indexed: r.n - (r.x ?? 0), mirrored: r.m ?? 0, removed: r.x ?? 0 };
    }
    return out;
  }

  private upsert(source: IconSource, entries: IndexEntry[], extra?: Map<string, { hash: string; format?: string }>, mirrored?: boolean): void {
    const t = Date.now();
    const ins = this.db.prepare(`INSERT INTO icon_index (source, slug, format, formats, label, search_text, content_hash, mirrored, removed_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(source, slug) DO UPDATE SET format = excluded.format, formats = excluded.formats, label = excluded.label, search_text = excluded.search_text, removed_at = NULL, synced_at = excluded.synced_at,
        content_hash = CASE WHEN excluded.content_hash <> '' THEN excluded.content_hash ELSE icon_index.content_hash END,
        mirrored = CASE WHEN ? THEN 1 ELSE icon_index.mirrored END`);
    tx(this.db, () => {
      for (const e of entries) {
        const x = extra?.get(e.slug);
        ins.run(source, e.slug, x?.format ?? e.format, e.formats.join(","), e.label, e.searchText, x?.hash ?? "", mirrored ? 1 : 0, t, mirrored ? 1 : 0);
      }
      this.db.prepare("UPDATE icon_index SET removed_at = ? WHERE source = ? AND synced_at < ? AND removed_at IS NULL").run(t, source, t);
    });
  }

  /** The names and tags of every icon, so search works without downloading the icons themselves. */
  private async syncIndexJson(source: IconSource): Promise<number> {
    const url = this.urls.index(source);
    if (!url) throw new Error("This library has no list to download");
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`The ${SOURCE_NAMES[source]} list answered ${res.status}`);
    const entries = (source === "dashboard-icons" ? parseDashboardIcons : parseSelfhst)(await res.json());
    if (!entries.length) throw new Error(`The ${SOURCE_NAMES[source]} list was empty, so nothing was changed`);
    this.upsert(source, entries);
    return entries.length;
  }

  private async openTarball(source: IconSource): Promise<Readable> {
    const url = await this.urls.tarball(source);
    const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`The ${SOURCE_NAMES[source]} download answered ${res.status}`);
    return Readable.fromWeb(res.body as never);
  }

  /** Lucide ships names, tags and icons in one small package, so the list and the mirror come from one download. */
  private async syncLucide(mirror: boolean): Promise<number> {
    const svgs = new Map<string, Buffer>(); let tags: Record<string, string[]> = {};
    const stream = await this.openTarball("lucide");
    await readTarGz(stream, (name, size) => size < 200_000 && (/\/tags\.json$/.test(name) || /\/icons\/[^/]+\.svg$/.test(name)), (name, data) => {
      if (name.endsWith("/tags.json")) { try { tags = JSON.parse(data.toString("utf8")); } catch { /* names only */ } }
      else svgs.set(name.split("/").pop()!.slice(0, -4), data);
    });
    if (!svgs.size) throw new Error("The Lucide download did not contain any icons");
    const entries = parseLucide([...svgs.keys()], tags), extra = new Map<string, { hash: string }>();
    for (const e of entries) {
      const buf = recolorLucide(svgs.get(e.slug)!);
      if (!svgIsSafe(buf.toString("utf8"))) continue;
      extra.set(e.slug, { hash: sha(buf) });
      if (mirror) { const d = join(this.mirrorDir, "lucide", "svg"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${e.slug}.svg`), buf); }
      this.jobs.lucide.progress++;
    }
    this.upsert("lucide", entries.filter(e => extra.has(e.slug)), extra, mirror);
    return extra.size;
  }

  /** Every icon, in one format (the best available) or all of them, kept on disk so nothing has to be fetched later. */
  private async syncMirrorTar(source: IconSource, single: boolean): Promise<number> {
    const known = new Map(this.db.prepare("SELECT slug, format FROM icon_index WHERE source = ? AND removed_at IS NULL").all(source).map(r => [(r as { slug: string }).slug, (r as { format: string }).format]));
    const best = new Map<string, { format: string; hash: string }>();
    const stream = await this.openTarball(source);
    const split = (name: string) => { const p = name.split("/"); return p.length === 3 && (LIBRARY_FORMATS as readonly string[]).includes(p[1]) && p[2].endsWith(`.${p[1]}`) ? { fmt: p[1], slug: p[2].slice(0, -(p[1].length + 1)) } : null; };
    await readTarGz(stream, (name, size) => {
      const s = split(name);
      if (!s || !SLUG.test(s.slug) || size > MAX_IMAGE) return false;
      if (single && known.has(s.slug) && known.get(s.slug) !== s.fmt) return false;
      return true;
    }, (name, data) => {
      const s = split(name)!;
      const prev = best.get(s.slug);
      if (single && prev && FORMAT_RANK[prev.format] <= FORMAT_RANK[s.fmt]) return;
      let k: ReturnType<typeof checkImage>;
      try { k = checkImage(data, [s.fmt]); } catch { return; }
      const d = join(this.mirrorDir, source, s.fmt);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${s.slug}.${s.fmt}`), k.buf);
      if (single && prev) { try { rmSync(join(this.mirrorDir, source, prev.format, `${s.slug}.${prev.format}`), { force: true }); } catch { /* ignore */ } }
      if (!prev || FORMAT_RANK[s.fmt] < FORMAT_RANK[prev.format]) best.set(s.slug, { format: s.fmt, hash: sha(k.buf) });
      this.jobs[source].progress++;
    });
    if (!best.size) throw new Error(`The ${SOURCE_NAMES[source]} download did not contain any icons`);
    const t = Date.now();
    const up = this.db.prepare(`INSERT INTO icon_index (source, slug, format, formats, label, search_text, content_hash, mirrored, removed_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
      ON CONFLICT(source, slug) DO UPDATE SET format = excluded.format, content_hash = excluded.content_hash, mirrored = 1`);
    tx(this.db, () => { for (const [slug, b] of best) up.run(source, slug, b.format, b.format, iconLabel(slug), norm(slug, slug.replace(/-/g, " ")), b.hash, t); });
    return best.size;
  }

  private enqueue(source: IconSource, work: () => Promise<void>): Promise<void> {
    const job = this.jobs[source];
    if (job.status === "queued" || job.status === "running") return this.chain;
    job.status = "queued";
    this.chain = this.chain.then(async () => {
      job.status = "running"; job.progress = 0; job.error = null;
      try { await work(); job.status = "idle"; }
      catch (error) {
        job.status = "error";
        job.error = error instanceof Error ? (error.name === "TimeoutError" ? "The download took too long." : /fetch failed/i.test(error.message) ? "The library could not be reached from here." : error.message) : "The refresh failed.";
        logEvent(this.db, "warn", "system", `The ${SOURCE_NAMES[source]} icon library could not be refreshed: ${job.error}`);
      }
      try { this.persist(); } catch { /* the database was closed while this ran */ }
      this.sizeMemo = null;
    });
    return this.chain;
  }

  /** Refreshes one library: its list always, and its local copy too when the chosen storage option keeps one. */
  syncSource(source: IconSource): Promise<void> {
    return this.enqueue(source, async () => {
      const tier = this.tier(), mirror = tier === "mirror-single" || tier === "mirror-full";
      let count: number;
      if (source === "lucide") count = await this.syncLucide(mirror);
      else {
        count = await this.syncIndexJson(source);
        this.jobs[source].indexAt = Date.now();
        if (mirror) count = await this.syncMirrorTar(source, tier === "mirror-single");
      }
      const now = Date.now();
      this.jobs[source].indexAt = now;
      if (mirror) this.jobs[source].mirrorAt = now;
      logEvent(this.db, "info", "system", `The ${SOURCE_NAMES[source]} icon library was refreshed (${count.toLocaleString()} icons${mirror ? ", copied to this server" : ""})`);
    });
  }

  syncAll(): Promise<void> { return Promise.all(ICON_SOURCES.map(s => this.syncSource(s))).then(() => undefined); }

  /** Called when the storage option changes: space the new option does not need is given back, and a bigger option starts filling. */
  applyTier(): void {
    const tier = this.tier();
    if (tier === "search") { try { rmSync(this.cacheDir, { recursive: true, force: true }); } catch { /* ignore */ } this.cacheBytes = 0; }
    if (tier === "search" || tier === "cached") {
      try { rmSync(this.mirrorDir, { recursive: true, force: true }); } catch { /* ignore */ }
      this.db.prepare("UPDATE icon_index SET mirrored = 0").run();
      for (const s of ICON_SOURCES) this.jobs[s].mirrorAt = null;
    } else if (tier === "mirror-single") {
      // Going from every format to one format: drop the extra copies.
      for (const s of ICON_SOURCES) for (const fmt of ["png", "webp"]) { try { rmSync(join(this.mirrorDir, s, fmt), { recursive: true, force: true }); } catch { /* ignore */ } }
      this.db.prepare("UPDATE icon_index SET mirrored = 0 WHERE source <> 'lucide'").run();
      for (const s of ICON_SOURCES) if (s !== "lucide") this.jobs[s].mirrorAt = null;
    }
    this.sizeMemo = null; this.persist();
    void this.syncAll();
  }

  /** Refresh anything older than a day. Does nothing until an administrator has chosen a storage option. */
  async tick(): Promise<void> {
    if (!this.reviewed()) return;
    const tier = this.tier(), mirror = tier === "mirror-single" || tier === "mirror-full";
    for (const s of ICON_SOURCES) {
      const j = this.jobs[s];
      const stale = !j.indexAt || Date.now() - j.indexAt > 23 * 3600_000 || (mirror && (!j.mirrorAt || Date.now() - j.mirrorAt > 23 * 3600_000));
      if (stale && (j.status === "idle" || j.status === "error") && !(j.status === "error" && j.indexAt && Date.now() - j.indexAt < 3600_000)) void this.syncSource(s);
    }
  }

  start(): void {
    this.first = setTimeout(() => void this.tick(), 20_000); this.first.unref();
    this.timer = setInterval(() => void this.tick(), 3600_000); this.timer.unref();
  }
  stop(): void { clearTimeout(this.first); clearInterval(this.timer); }

  /** Waits for any refresh in progress (used by tests and when the app closes). */
  idle(): Promise<void> { return this.chain; }

  // ---- "update available"

  /** Notes what each library icon in use looks like today, so changes can be shown. Mirrored icons already know; others are fetched once. */
  async checkUsed(refs: string[]): Promise<number> {
    let checked = 0;
    for (const ref of new Set(refs)) {
      const p = parseRef(ref); if (!p) continue;
      const r = this.row(p.source, p.slug);
      if (r?.mirrored && r.content_hash) { checked++; continue; }
      const got = await this.bytes(p.source, p.slug, { fresh: true });
      if (!got) continue;
      const h = sha(got.buf);
      if (r) this.db.prepare("UPDATE icon_index SET content_hash = ? WHERE source = ? AND slug = ?").run(h, p.source, p.slug);
      else this.db.prepare("INSERT INTO icon_index (source, slug, format, formats, label, search_text, content_hash, mirrored, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)").run(p.source, p.slug, got.ext, got.ext, iconLabel(p.slug), norm(p.slug), h, Date.now());
      checked++;
    }
    return checked;
  }

  /** True when the library's current file differs from the copy saved on the thing. */
  changed(icon: string, ref: string): boolean {
    const p = parseRef(ref), have = iconHash(icon);
    if (!p || !have) return false;
    const r = this.row(p.source, p.slug);
    return Boolean(r && !r.removed_at && r.content_hash && r.content_hash.slice(0, have.length) !== have);
  }
}
