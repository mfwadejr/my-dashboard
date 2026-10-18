import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Confirm } from "../widgets/common";
import { fmtDateTime, useSettings } from "../settings";
import { Row, Section, bytes, download, useNotice, useSaveSettings } from "./ui";

interface Snap { name: string; size: number; ts: number; auto: boolean }
interface Preview { createdAt: string; app: { version: string; commit: string }; encrypted: boolean; passphraseOk: boolean | null; tabs: number; groups: number; tiles: number; integrations: number; cameras: number; adds: { tabs: number; integrations: number; cameras: number }; removes: { integrations: number; cameras: number; tabs: number } | null }
interface Result { mode: string; added: { tabs: number; integrations: number; cameras: number }; skipped: { tabs: number; integrations: number; cameras: number }; needsSecrets: string[] }
interface Stats { key: { source: "env" | "file"; file: string | null } }

export function Data({ onRestored }: { onRestored: () => void }) {
  const { settings } = useSettings();
  const save = useSaveSettings();
  const ex = useNotice(), im = useNotice(), sn = useNotice(), ky = useNotice(), dz = useNotice();
  const [pass, setPass] = useState("");
  const [file, setFile] = useState<any>(null);
  const [fileName, setFileName] = useState("");
  const [ipass, setIpass] = useState("");
  const [mode, setMode] = useState<"replace" | "merge">("replace");
  const [skip, setSkip] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [keyPw, setKeyPw] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  const loadSnaps = () => api.get<Snap[]>("/api/backup/snapshots").then(setSnaps).catch(() => {});
  useEffect(() => { void loadSnaps(); void api.get<Stats>("/api/data/stats").then(setStats).catch(() => {}); }, []);

  const doExport = async () => {
    ex.clear();
    try {
      const doc = await api.post<unknown>("/api/backup/export", { passphrase: pass || undefined });
      const stamp = new Date().toISOString().slice(0, 10);
      download(`homebase-backup-${stamp}.json`, JSON.stringify(doc, null, 2));
      ex.ok(pass ? "Saved. Passwords and keys are inside, protected by your passphrase. Keep the passphrase safe: it cannot be recovered." : "Saved. Passwords and API keys are NOT in this file, so you will enter them again after restoring.");
    } catch (e) { ex.bad(e); }
  };

  const ask = async (m = mode, p = ipass, f = file) => {
    if (!f) return;
    im.clear(); setResult(null);
    try { setPreview((await api.post<{ preview: Preview }>("/api/backup/import", { file: f, mode: m, passphrase: p || undefined, skipSecrets: skip, dryRun: true })).preview); }
    catch (e) { setPreview(null); im.bad(e); }
  };
  const onFile = async (f: File | undefined) => {
    setPreview(null); setResult(null); im.clear();
    if (!f) return;
    try { const doc = JSON.parse(await f.text()); setFile(doc); setFileName(f.name); await ask(mode, ipass, doc); }
    catch { setFile(null); setFileName(""); im.bad(new Error("That file could not be read. Choose a Homebase backup (.json).")); }
  };
  const apply = async () => {
    im.clear();
    try {
      const r = (await api.post<{ result: Result }>("/api/backup/import", { file, mode, passphrase: ipass || undefined, skipSecrets: skip })).result;
      setResult(r); setPreview(null); setFile(null); setFileName(""); void loadSnaps(); onRestored();
    } catch (e) { im.bad(e); }
  };

  const makeCopy = async () => { sn.clear(); try { await api.post("/api/backup/snapshots"); sn.ok("A copy of the database was saved."); void loadSnaps(); } catch (e) { sn.bad(e); } };
  const getKey = async () => {
    ky.clear();
    try { const r = await api.post<{ key: string }>("/api/backup/secret-key", { password: keyPw }); download("secret.key", r.key, "text/plain"); setKeyPw(""); ky.ok("Downloaded. Store it somewhere safe, separate from your backups."); }
    catch (e) { ky.bad(e); }
  };

  return (
    <>
      <Section title="Export a backup file" hint="One file with your tabs, tiles, connections, cameras and settings. Use it to move to a new machine or to keep a copy off the server.">
        <Row label="Passphrase (optional)" hint="Without one, passwords and API keys are left out. With one, they are included, encrypted so only the passphrase opens them. Share links and accounts are never included.">
          <input type="password" autoComplete="new-password" value={pass} placeholder="At least 8 characters" onChange={e => setPass(e.target.value)} />
        </Row>
        <Row label=""><button className="btn pri" onClick={() => void doExport()}>Download backup</button></Row>
        {ex.el}
      </Section>

      <Section title="Restore from a backup file" hint="You will see exactly what it contains before anything changes. Replacing makes a safety copy of the database first.">
        <Row label="Backup file">
          <span className="row wrapme"><input ref={pick} type="file" accept=".json,application/json" hidden onChange={e => void onFile(e.target.files?.[0])} />
            <button className="btn" onClick={() => pick.current?.click()}>Choose file…</button><span className="sub">{fileName || "No file chosen"}</span></span>
        </Row>
        {file && (
          <>
            <Row label="How"><select value={mode} onChange={e => { const m = e.target.value as "replace" | "merge"; setMode(m); void ask(m); }}><option value="replace">Replace everything with the file</option><option value="merge">Add only what is missing (keep what I have)</option></select></Row>
            {preview?.encrypted && (
              <Row label="Passphrase" hint="This file is protected.">
                <span className="row wrapme"><input type="password" autoComplete="off" value={ipass} disabled={skip} onChange={e => setIpass(e.target.value)} onBlur={() => void ask()} />
                  <label className="check"><input type="checkbox" checked={skip} onChange={e => { setSkip(e.target.checked); }} /> Restore without the saved passwords and keys</label></span>
              </Row>
            )}
          </>
        )}
        {preview && (
          <div className="preview">
            <b>This file ({preview.createdAt ? new Date(preview.createdAt).toLocaleString([], { timeZone: settings.timezone }) : "undated"}, version {preview.app.version}) contains:</b>
            <ul>
              <li>{preview.tabs} tab(s), {preview.groups} group(s), {preview.tiles} tile(s)</li>
              <li>{preview.integrations} connection(s) and {preview.cameras} camera(s)</li>
              <li>{preview.encrypted ? (skip ? "Protected passwords and keys: will be skipped" : preview.passphraseOk === true ? "Passwords and keys: unlocked with your passphrase" : preview.passphraseOk === false ? "Passwords and keys: that passphrase is wrong" : "Passwords and keys: protected, passphrase needed") : "No passwords or keys (you will enter them again)"}</li>
            </ul>
            <p className="sub">{mode === "replace" ? `Will replace your current ${preview.removes?.tabs ?? 0} tab(s), ${preview.removes?.integrations ?? 0} connection(s) and ${preview.removes?.cameras ?? 0} camera(s).` : `Will add ${preview.adds.tabs} tab(s), ${preview.adds.integrations} connection(s) and ${preview.adds.cameras} camera(s). Anything you already have stays as it is.`}</p>
            <button className="btn pri" disabled={Boolean(preview.encrypted && !skip && preview.passphraseOk !== true)} onClick={() => void apply()}>{mode === "replace" ? "Replace with this backup" : "Add what is missing"}</button>
          </div>
        )}
        {result && (
          <div className="preview">
            <b>Done.</b> Added {result.added.tabs} tab(s), {result.added.integrations} connection(s), {result.added.cameras} camera(s).
            {result.needsSecrets.length > 0 && <><p className="sub">These still need a password or key (edit them in Connections or on their camera):</p><ul>{result.needsSecrets.map(n => <li key={n}>{n}</li>)}</ul></>}
          </div>
        )}
        {im.el}
      </Section>

      <Section title="Database copies" hint="A copy of the live database is saved to the data folder every night, and before anything that replaces your layout. These are real SQLite files you can download. To use one, stop Homebase, replace homebase.db in the data folder with it and start again.">
        <Row label="Nightly copy"><label className="check"><input type="checkbox" checked={settings.autoBackup} onChange={e => void save.save({ autoBackup: e.target.checked })} /> Save a copy every night</label></Row>
        <Row label="Keep the last"><select value={settings.backupKeep} onChange={e => void save.save({ backupKeep: Number(e.target.value) })}>{[3, 7, 14, 30].map(n => <option key={n} value={n}>{n} copies</option>)}</select></Row>
        <Row label=""><button className="btn" onClick={() => void makeCopy()}>Save a copy now</button></Row>
        {snaps.length === 0 ? <p className="sub">No copies yet.</p> : (
          <div className="rows">{snaps.map(s => (
            <div key={s.name} className="srow"><div className="trunc"><b>{s.name}</b><div className="sub">{fmtDateTime(s.ts, settings)} · {bytes(s.size)}{s.auto ? "" : " · safety copy"}</div></div>
              <span className="row"><a className="btn sm" href={`/api/backup/snapshots/${s.name}`} download>Download</a>
                <Confirm label="Delete" name={`Delete ${s.name}`} sure="Sure?" onGo={async () => { try { await api.del(`/api/backup/snapshots/${s.name}`); void loadSnaps(); } catch (e) { sn.bad(e); } }} /></span></div>
          ))}</div>
        )}
        {sn.el}
      </Section>

      <Section title="Encryption key" hint="Passwords and API keys in the database are encrypted with a key kept in a separate file. If you lose that file, saved passwords and keys cannot be read, even from a good database copy. Keep a copy of it somewhere safe, apart from your backups.">
        {stats?.key.source === "env" ? <p className="sub">The key comes from the HOMEBASE_SECRET_KEY setting of the container, so there is no file to download. Keep that value safe.</p> : (
          <>
            <Row label="Key file" hint={stats?.key.file ? `Stored at ${stats.key.file} inside the container.` : undefined}>
              <span className="row wrapme"><input type="password" autoComplete="current-password" placeholder="Your password" value={keyPw} onChange={e => setKeyPw(e.target.value)} /><button className="btn" disabled={!keyPw} onClick={() => void getKey()}>Download key</button></span>
            </Row>
            {ky.el}
          </>
        )}
      </Section>

      <Section title="Danger zone" danger hint="A safety copy is saved first where it applies, but be sure.">
        <Row label="Reset the layout" hint="Replaces every tab and tile with the starter layout. Connections and cameras stay."><Confirm label="Reset layout…" name="Reset layout" sure="Click again to reset" onGo={async () => { try { await api.post("/api/data/reset-layout"); dz.ok("The layout was reset."); onRestored(); } catch (e) { dz.bad(e); } }} /></Row>
        <Row label="Clear the log" hint="Removes every line from the log."><Confirm label="Clear log…" name="Clear log" sure="Click again to clear" onGo={async () => { try { await api.post("/api/data/clear-logs"); dz.ok("The log was cleared."); } catch (e) { dz.bad(e); } }} /></Row>
        {dz.el}
      </Section>
    </>
  );
}
