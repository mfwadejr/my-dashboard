import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { ValidationError } from "./dashboard.js";
import { snapshotInto, stampNow } from "./db.js";
import type { Deps } from "./deps.js";
import { checkImage } from "./icons.js";
import { referencedIcons } from "./iconuse.js";
import { readTarGz, tarChunks, type TarSource } from "./tarstream.js";
import { versionInfo } from "./version.js";
import { finish, verifyDatabaseFile, type Check, type VerifyReport } from "./verify.js";

export const COMPLETE_FORMAT = "homebase-complete";
export interface CompleteManifest { format: typeof COMPLETE_FORMAT; formatVersion: 1; createdAt: string; app: { version: string; commit: string }; icons: Array<{ name: string; size: number; sha256: string }> }
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const isGzip = (file: string) => { try { const fd = readFileSync(file).subarray(0, 2); return fd[0] === 0x1f && fd[1] === 0x8b; } catch { return false; } };
export const looksLikeComplete = isGzip;

/** One download with everything: a consistent copy of the database and every saved icon it uses (not the big library mirror, which downloads again). */
export async function createComplete(deps: Deps): Promise<{ file: string; name: string; size: number; dir: string }> {
  const { db, icons, backups } = deps;
  mkdirSync(backups.tmp, { recursive: true });
  const dir = mkdtempSync(join(backups.tmp, "complete-"));
  try {
    const snap = snapshotInto(db, dir, "");
    const files: TarSource[] = [], listed: CompleteManifest["icons"] = [];
    for (const name of referencedIcons(db)) {
      if (!name.startsWith("used/")) continue;
      const p = icons.file(name); if (!p) continue;
      const buf = readFileSync(p);
      listed.push({ name, size: buf.length, sha256: sha(buf) });
      files.push({ name: `icons/${name}`, data: buf });
    }
    const v = versionInfo();
    const manifest: CompleteManifest = { format: COMPLETE_FORMAT, formatVersion: 1, createdAt: new Date().toISOString(), app: { version: v.version, commit: v.commit }, icons: listed };
    const entries: TarSource[] = [{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) }, { name: "homebase.db", file: join(dir, snap.name), size: snap.size }, ...files];
    const name = `homebase-complete-${stampNow()}.tar.gz`, out = join(dir, name);
    await pipeline(Readable.from(tarChunks(entries, p => createReadStream(p))), createGzip(), createWriteStream(out));
    return { file: out, name, size: statSync(out).size, dir };
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}

export interface OpenedComplete { manifest: CompleteManifest; dbFile: string; icons: Map<string, Buffer>; dir: string }

/** Unpacks a Complete backup into a fresh temporary folder (the caller removes `dir`). */
export async function readComplete(file: string, tmpRoot: string): Promise<OpenedComplete> {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, "unpack-"));
  const icons = new Map<string, Buffer>(); let manifest: CompleteManifest | null = null;
  try {
    await readTarGz(createReadStream(file), (name, size) => name === "manifest.json" ? size < 2_000_000 : name === "homebase.db" ? { toFile: join(dir, "homebase.db") } : /^icons\/used\/[^/]+$/.test(name) && size <= 2 * 1024 * 1024, (name, data) => {
      if (name === "manifest.json") { try { manifest = JSON.parse(data.toString("utf8")); } catch { /* reported below */ } }
      else if (name.startsWith("icons/")) icons.set(name.slice("icons/used/".length), data);
    });
  } catch { throw new ValidationError("This archive could not be read. It may be damaged or cut short."); }
  const m = manifest as CompleteManifest | null;
  if (!m || m.format !== COMPLETE_FORMAT) throw new ValidationError("This is not a Homebase Complete backup");
  if (m.formatVersion > 1) throw new ValidationError("This backup was made by a newer Homebase. Update first");
  if (!existsSync(join(dir, "homebase.db"))) throw new ValidationError("The archive has no database inside");
  return { manifest: m, dbFile: join(dir, "homebase.db"), icons, dir };
}

/** The database checks plus a check that every icon listed is present, unchanged and a safe image. */
export function verifyComplete(deps: Deps, o: OpenedComplete, size: number, tmpRoot: string): VerifyReport {
  const has = (n: string) => o.icons.has(n.replace(/^used\//, ""));
  const db = verifyDatabaseFile(o.dbFile, deps.box, tmpRoot, Date.parse(o.manifest.createdAt) || Date.now(), { hasIcon: has, iconsWhere: "inside this archive" });
  const checks: Check[] = [{ id: "archive", label: "Archive", status: "pass", detail: `A Complete backup made by version ${o.manifest.app.version}: a database copy and ${o.manifest.icons.length} saved icon(s).` }, ...db.checks];
  const bad: string[] = [];
  for (const i of o.manifest.icons) {
    const buf = o.icons.get(i.name.replace(/^used\//, ""));
    if (!buf) { bad.push(`${i.name} is missing`); continue; }
    if (sha(buf) !== i.sha256) { bad.push(`${i.name} does not match its fingerprint`); continue; }
    try { checkImage(buf, ["svg", "png", "jpg", "gif", "webp"]); } catch (e) { bad.push(`${i.name}: ${e instanceof Error ? e.message : "not a safe image"}`); }
  }
  checks.push(bad.length ? { id: "iconfiles", label: "Icon files", status: "fail", detail: `${bad.length} icon file(s) in the archive are not intact: ${bad.slice(0, 3).join("; ")}.` } : { id: "iconfiles", label: "Icon files", status: "pass", detail: o.manifest.icons.length ? `All ${o.manifest.icons.length} icon file(s) are present and unchanged.` : "No icons are listed." });
  return finish("complete", checks, db.counts, size, db.createdAt, db.layout);
}
