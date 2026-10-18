import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Confirm } from "../widgets/common";
import { useSettings } from "../settings";
import { Copies } from "./Copies";
import { Destinations } from "./Destinations";
import { Maintenance } from "./Maintenance";
import { Retention } from "./Retention";
import type { IntegrationInfo } from "../types";
import { Row, Section, download, useNotice } from "./ui";

interface Preview { accounts: { included: boolean; count: number | null; youWillBeSignedOut: boolean }; createdAt: string; app: { version: string; commit: string }; encrypted: boolean; passphraseOk: boolean | null; tabs: number; groups: number; tiles: number; integrations: number; cameras: number; adds: { tabs: number; integrations: number; cameras: number }; removes: { integrations: number; cameras: number; tabs: number } | null }
interface Result { accounts: { added: number; removed: number; signedOut: boolean } | null; mode: string; added: { tabs: number; integrations: number; cameras: number }; skipped: { tabs: number; integrations: number; cameras: number }; needsSecrets: string[] }
interface Stats { key: { source: "env" | "file"; file: string | null } }

type SubTab = "backups" | "export" | "storage" | "upkeep";
const SUBTABS: Array<{ id: SubTab; label: string; hint: string }> = [
  { id: "backups", label: "Backups", hint: "Database copies, copies on your network, Complete backup, check a file" },
  { id: "export", label: "Export & restore", hint: "Backup file, restoring, encryption key" },
  { id: "storage", label: "History & log", hint: "How long graph history and the log are kept, and the saved log files" },
  { id: "upkeep", label: "Upkeep & reset", hint: "Database upkeep, resetting the layout, clearing the log" }
];

export function Data({ onRestored, integrations }: { onRestored: () => void; integrations: IntegrationInfo[] }) {
  const { settings } = useSettings();
  const [tab, setTabState] = useState<SubTab>(() => { try { const v = sessionStorage.getItem("hb_data_tab"); return v === "export" || v === "storage" || v === "upkeep" ? v : "backups"; } catch { return "backups"; } });
  const setTab = (t: SubTab) => { setTabState(t); try { sessionStorage.setItem("hb_data_tab", t); } catch { /* remembering is optional */ } window.scrollTo(0, 0); };
  const ex = useNotice(), im = useNotice(), ky = useNotice(), dz = useNotice();
  const [pass, setPass] = useState("");
  const [withAccounts, setWithAccounts] = useState(false);
  const [restoreAcc, setRestoreAcc] = useState(false);
  const [file, setFile] = useState<any>(null);
  const [fileName, setFileName] = useState("");
  const [ipass, setIpass] = useState("");
  const [mode, setMode] = useState<"replace" | "merge">("replace");
  const [skip, setSkip] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [keyPw, setKeyPw] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  useEffect(() => { void api.get<Stats>("/api/data/stats").then(setStats).catch(() => {}); }, []);

  const doExport = async () => {
    ex.clear();
    try {
      const doc = await api.post<unknown>("/api/backup/export", { passphrase: pass || undefined, includeAccounts: withAccounts && Boolean(pass) });
      const stamp = new Date().toISOString().slice(0, 10);
      download(`homebase-backup-${stamp}.json`, JSON.stringify(doc, null, 2));
      ex.ok(pass ? `Saved. Passwords and keys${withAccounts ? " and accounts" : ""} are inside, protected by your passphrase. Keep the passphrase safe: it cannot be recovered.` : "Saved. Passwords and API keys are NOT in this file, so you will enter them again after restoring.");
    } catch (e) { ex.bad(e); }
  };

  const ask = async (m = mode, p = ipass, f = file, ra = restoreAcc) => {
    if (!f) return;
    im.clear(); setResult(null);
    try { setPreview((await api.post<{ preview: Preview }>("/api/backup/import", { file: f, mode: m, passphrase: p || undefined, skipSecrets: skip, restoreAccounts: ra, dryRun: true })).preview); }
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
      const r = (await api.post<{ result: Result }>("/api/backup/import", { file, mode, passphrase: ipass || undefined, skipSecrets: skip, restoreAccounts: restoreAcc })).result;
      setResult(r); setPreview(null); setFile(null); setFileName(""); onRestored();
    } catch (e) { im.bad(e); }
  };

  const getKey = async () => {
    ky.clear();
    try { const r = await api.post<{ key: string }>("/api/backup/secret-key", { password: keyPw }); download("secret.key", r.key, "text/plain"); setKeyPw(""); ky.ok("Downloaded. Store it somewhere safe, separate from your backups."); }
    catch (e) { ky.bad(e); }
  };

  return (
    <>
      <div className="subtabs" role="tablist" aria-label="Data and backup sections">
        {SUBTABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} title={t.hint} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <p className="sub subtab-hint">{SUBTABS.find(t => t.id === tab)?.hint}</p>

      {tab === "backups" && (
        <>
      <Copies />
      <Destinations />
        </>
      )}

      {tab === "export" && (
        <>
      <Section title="Export a backup file" hint="One file with your tabs, tiles, connections, cameras and settings. Use it to move to a new machine or to keep a copy off the server.">
        <Row label="Passphrase (optional)" hint="Without one, passwords and API keys are left out. With one, they are included, encrypted so only the passphrase opens them. Share links are never included.">
          <input type="password" autoComplete="new-password" value={pass} placeholder="At least 8 characters" onChange={e => setPass(e.target.value)} />
        </Row>
        <Row label="Accounts" hint="Names, roles and password hashes, so a full rebuild does not mean re-creating people. They are inside the protected section, so they need the passphrase.">
          <label className="check"><input type="checkbox" checked={withAccounts && Boolean(pass)} disabled={!pass} onChange={e => setWithAccounts(e.target.checked)} /> Include accounts</label>
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
              <li>{preview.accounts.included ? `Accounts: ${preview.accounts.count ?? "included (enter the passphrase to see how many)"}` : "No accounts (your current accounts stay as they are)"}</li>
              <li>{preview.encrypted ? (skip ? "Protected passwords and keys: will be skipped" : preview.passphraseOk === true ? "Passwords and keys: unlocked with your passphrase" : preview.passphraseOk === false ? "Passwords and keys: that passphrase is wrong" : "Passwords and keys: protected, passphrase needed") : "No passwords or keys (you will enter them again)"}</li>
            </ul>
            {preview.accounts.included && preview.accounts.count !== null && !skip && (
              <label className="check"><input type="checkbox" checked={restoreAcc} onChange={e => { setRestoreAcc(e.target.checked); void ask(mode, ipass, file, e.target.checked); }} /> Restore the accounts too{mode === "replace" ? " (accounts not in the file are removed)" : " (only people who are missing are added)"}</label>
            )}
            {preview.accounts.youWillBeSignedOut && <p className="error">Restoring accounts signs everyone out, including you. Sign in again with the account from the backup.</p>}
            <p className="sub">{mode === "replace" ? `Will replace your current ${preview.removes?.tabs ?? 0} tab(s), ${preview.removes?.integrations ?? 0} connection(s) and ${preview.removes?.cameras ?? 0} camera(s).` : `Will add ${preview.adds.tabs} tab(s), ${preview.adds.integrations} connection(s) and ${preview.adds.cameras} camera(s). Anything you already have stays as it is.`}</p>
            <button className="btn pri" disabled={Boolean(preview.encrypted && !skip && preview.passphraseOk !== true)} onClick={() => void apply()}>{mode === "replace" ? "Replace with this backup" : "Add what is missing"}</button>
          </div>
        )}
        {result && (
          <div className="preview">
            <b>Done.</b> Added {result.added.tabs} tab(s), {result.added.integrations} connection(s), {result.added.cameras} camera(s).{result.accounts ? ` Accounts: ${result.accounts.added} added, ${result.accounts.removed} removed.` : ""}
            {result.needsSecrets.length > 0 && <><p className="sub">These still need a password or key (edit them in Connections or on their camera):</p><ul>{result.needsSecrets.map(n => <li key={n}>{n}</li>)}</ul></>}
          </div>
        )}
        {im.el}
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

        </>
      )}

      {tab === "storage" && (
        <>
      <Retention integrations={integrations} />
        </>
      )}

      {tab === "upkeep" && (
        <>
      <Maintenance />

      <Section title="Danger zone" danger hint="A safety copy is saved first where it applies, but be sure.">
        <Row label="Reset the layout" hint="Replaces every tab and tile with the starter layout. Connections and cameras stay."><Confirm label="Reset layout…" name="Reset layout" sure="Click again to reset" onGo={async () => { try { await api.post("/api/data/reset-layout"); dz.ok("The layout was reset."); onRestored(); } catch (e) { dz.bad(e); } }} /></Row>
        <Row label="Clear the log" hint="Removes every line from the log."><Confirm label="Clear log…" name="Clear log" sure="Click again to clear" onGo={async () => { try { await api.post("/api/data/clear-logs"); dz.ok("The log was cleared."); } catch (e) { dz.bad(e); } }} /></Row>
        {dz.el}
      </Section>
        </>
      )}
    </>
  );
}
