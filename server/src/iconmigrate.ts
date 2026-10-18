import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logEvent, setMeta, getMeta } from "./db.js";
import type { Deps } from "./deps.js";
import { checkImage } from "./icons.js";
import { applyIcons, listHolders } from "./iconuse.js";
import { verifyDatabaseFile } from "./verify.js";

const FLAT = /^[a-f0-9]{24}\.(?:png|jpg|gif|webp|svg)$/;
const OLD_LIBRARY = /^di:([a-z0-9][a-z0-9-]{0,100})$/;

export interface MigrationResult { moved: number; cleared: number; library: number; copy: string | null }

/**
 * Brings icons saved by older versions into the new layout: loose files in the icons folder move to icons/used with a cache-busting
 * address, and old "di:name" references become saved library icons. A verified copy of the database is saved first. It changes nothing
 * once everything is migrated, so it is safe to run on every start.
 */
export function migrateLegacyIcons(deps: Deps): MigrationResult | null {
  const { db, icons, backups, box } = deps;
  const todo = listHolders(db).filter(h => FLAT.test(h.icon) || OLD_LIBRARY.test(h.icon));
  if (!todo.length) return null;

  let copy: string | null = null;
  try {
    copy = backups.create("before-icon-migration").name;
    const report = verifyDatabaseFile(join(backups.dir, copy), box, backups.tmp);
    if (!report.restorable) throw new Error(report.checks.find(c => c.status === "fail")?.detail ?? "the copy did not verify");
  } catch (error) {
    logEvent(db, "error", "system", `Saved icons were not moved to the new layout because a safe copy of the database could not be made first (${error instanceof Error ? error.message : error}). Nothing was changed.`);
    return null;
  }

  const changes = new Map<string, { icon: string; iconRef: string }>(), oldFiles = new Set<string>();
  let moved = 0, cleared = 0;
  mkdirSync(icons.usedDir, { recursive: true });
  for (const h of todo) {
    if (!FLAT.test(h.icon)) continue;
    const old = join(icons.dir, h.icon);
    try {
      if (!existsSync(old)) throw new Error("missing");
      const buf = readFileSync(old);
      const k = checkImage(buf, ["svg", "png", "jpg", "gif", "webp"]);
      const name = `upload-${h.icon.split(".")[0]}.${k.ext}`;
      const target = join(icons.usedDir, name);
      if (!existsSync(target)) { writeFileSync(`${target}.part`, buf); renameSync(`${target}.part`, target); }
      changes.set(h.key, { icon: `used/${name}?v=${createHash("sha256").update(buf).digest("hex").slice(0, 10)}`, iconRef: "" });
      oldFiles.add(old); moved++;
    } catch { changes.set(h.key, { icon: "", iconRef: "" }); cleared++; }
  }
  const library = todo.filter(h => OLD_LIBRARY.test(h.icon));
  let applied = 0;
  try { applied = applyIcons(db, changes); }
  catch (error) { logEvent(db, "error", "system", `Saved icons could not be moved to the new layout (${error instanceof Error ? error.message : error}). The old files were left in place; the safety copy ${copy} is in the backups list.`); return null; }
  // Only now, with every reference rewritten, do the old loose files go.
  for (const f of oldFiles) { try { rmSync(f); } catch { /* leftover files are harmless */ } }
  if (applied || library.length) logEvent(db, "info", "system", `Icons were moved to the new layout: ${moved} file(s) saved under icons/used${cleared ? `, ${cleared} could not be found and were cleared` : ""}${library.length ? `, ${library.length} library icon(s) will be saved when the library can be reached` : ""}. A verified copy of the database was saved first (${copy}).`);

  if (library.length) void migrateLibraryRefs(deps, library.map(h => ({ key: h.key, ref: `dashboard-icons:${OLD_LIBRARY.exec(h.icon)![1]}` })));
  return { moved, cleared, library: library.length, copy };
}

/** Old "di:name" references need the real picture, which means asking the library. If it cannot be reached they stay as they are and are tried again at the next start. */
async function migrateLibraryRefs(deps: Deps, items: Array<{ key: string; ref: string }>): Promise<void> {
  const { db, icons } = deps;
  const changes = new Map<string, { icon: string; iconRef: string }>(); let failed = 0;
  for (const it of items) {
    try { changes.set(it.key, await icons.freeze(it.ref)); } catch { failed++; }
  }
  try { if (changes.size) applyIcons(db, changes); } catch { /* retried next start */ }
  if (failed && getMeta(db, "icon_migrate_note") !== String(failed)) { setMeta(db, "icon_migrate_note", String(failed)); logEvent(db, "warn", "system", `${failed} older library icon(s) could not be saved yet because the icon library could not be reached. They will be tried again at the next start.`); }
}
