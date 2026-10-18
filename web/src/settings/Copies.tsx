import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Confirm } from "../widgets/common";
import { fmtDateTime, useSettings } from "../settings";
import type { VerifyReport } from "../types";
import { VerifyView } from "./Verify";
import { Row, Section, ago, bytes, useNotice, useSaveSettings } from "./ui";

interface Snap { name: string; size: number; ts: number; auto: boolean; verified: { ts: number; ok: boolean; summary: string } | null }
interface Sched { enabled: boolean; nextAt: number | null; lastAt: number | null }
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Waits for the server to go away and come back after a restore, then reloads the page. */
function useRestartWatch() {
  const [state, setState] = useState<"idle" | "waiting" | "stuck">("idle");
  const start = () => {
    setState("waiting");
    let down = false, tries = 0;
    const tick = async () => {
      tries++;
      let up = false;
      try { up = (await fetch("/api/health", { cache: "no-store" })).ok; } catch { up = false; }
      if (!up) down = true;
      if (up && down) { window.location.reload(); return; }
      if (tries > 45) { setState("stuck"); return; }
      window.setTimeout(tick, 1200);
    };
    window.setTimeout(tick, 1500);
  };
  return { state, start };
}

export function Copies() {
  const { settings } = useSettings();
  const save = useSaveSettings();
  const sn = useNotice(), vf = useNotice();
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [sched, setSched] = useState<Sched | null>(null);
  const [report, setReport] = useState<{ name: string; report: VerifyReport } | null>(null);
  const [restoring, setRestoring] = useState<{ name: string; report: VerifyReport; force: boolean } | null>(null);
  const [busy, setBusy] = useState("");
  const [filePass, setFilePass] = useState("");
  const [fileReport, setFileReport] = useState<{ name: string; report: VerifyReport } | null>(null);
  const addRef = useRef<HTMLInputElement>(null), verRef = useRef<HTMLInputElement>(null);
  const watch = useRestartWatch();

  const load = () => {
    void api.get<Snap[]>("/api/backup/snapshots").then(setSnaps).catch(() => {});
    void api.get<Sched>("/api/backup/schedule").then(setSched).catch(() => {});
  };
  useEffect(load, []);
  useEffect(() => { void api.get<Sched>("/api/backup/schedule").then(setSched).catch(() => {}); }, [settings.backupEvery, settings.backupTime, settings.backupDay, settings.autoBackup]);

  const makeCopy = async () => {
    sn.clear(); setBusy("make");
    try { await api.post("/api/backup/snapshots"); sn.ok("A copy of the database was saved and checked."); load(); } catch (e) { sn.bad(e); } finally { setBusy(""); }
  };
  const verify = async (name: string) => {
    sn.clear(); setBusy(name); setRestoring(null);
    try { setReport({ name, report: await api.post<VerifyReport>(`/api/backup/snapshots/${name}/verify`) }); load(); } catch (e) { sn.bad(e); } finally { setBusy(""); }
  };
  const askRestore = async (name: string) => {
    sn.clear(); setBusy(name); setReport(null);
    try { setRestoring({ name, report: await api.post<VerifyReport>(`/api/backup/snapshots/${name}/verify`), force: false }); load(); } catch (e) { sn.bad(e); } finally { setBusy(""); }
  };
  const doRestore = async () => {
    if (!restoring) return;
    sn.clear();
    try { await api.post(`/api/backup/snapshots/${restoring.name}/restore`, { force: restoring.force }); setRestoring(null); watch.start(); }
    catch (e) { sn.bad(e); }
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    sn.clear(); setBusy("upload");
    try {
      const form = new FormData(); form.append("file", f);
      const r = await api.post<{ name: string; report: VerifyReport }>("/api/backup/snapshots/upload", form);
      setReport({ name: r.name, report: r.report }); sn.ok(`Added to the list as ${r.name}.`); load();
    } catch (e) { sn.bad(e); } finally { setBusy(""); if (addRef.current) addRef.current.value = ""; }
  };
  const verifyFile = async (f: File | undefined) => {
    if (!f) return;
    vf.clear(); setFileReport(null); setBusy("file");
    try {
      const form = new FormData(); if (filePass) form.append("passphrase", filePass); form.append("file", f);
      setFileReport({ name: f.name, report: await api.post<VerifyReport>("/api/backup/verify-file", form) });
    } catch (e) { vf.bad(e); } finally { setBusy(""); if (verRef.current) verRef.current.value = ""; }
  };

  if (watch.state !== "idle") {
    return (
      <Section title="Restoring…" hint="Homebase is swapping in the chosen copy and restarting.">
        {watch.state === "waiting"
          ? <p className="sub" role="status">Waiting for Homebase to come back. This page reloads by itself when it does.</p>
          : <p className="error" role="alert">Homebase has not restarted on its own. The copy is queued and will be put in place the next time Homebase starts, so restart the container (for example from ZimaOS) to finish. If the container is set to “restart: unless-stopped” this normally happens automatically.</p>}
      </Section>
    );
  }

  const badge = (s: Snap) => s.verified
    ? <span className={`badge ${s.verified.ok ? "okb" : "badb"}`} title={s.verified.summary}>{s.verified.ok ? "✓ Verified" : "✕ Check failed"} {ago(s.verified.ts)}</span>
    : <span className="badge" title="This copy has not been checked yet">Not checked</span>;

  return (
    <>
      <Section title="Database copies" hint="Real copies of the live database, saved in the data folder, checked right after they are made, and sent to your network places below. Use Restore to go back to one.">
        <Row label="Scheduled copies"><label className="check"><input type="checkbox" checked={settings.autoBackup} onChange={e => void save.save({ autoBackup: e.target.checked })} /> Save copies on a schedule</label></Row>
        {settings.autoBackup && (
          <>
            <Row label="How often">
              <span className="row wrapme">
                <select value={settings.backupEvery} onChange={e => void save.save({ backupEvery: e.target.value as "6h" | "daily" | "weekly" })}><option value="6h">Every 6 hours</option><option value="daily">Every day</option><option value="weekly">Every week</option></select>
                {settings.backupEvery === "weekly" && <select aria-label="Day of the week" value={settings.backupDay} onChange={e => void save.save({ backupDay: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>}
                {settings.backupEvery !== "6h" && <input type="time" aria-label="Time of day" value={settings.backupTime} onChange={e => e.target.value && void save.save({ backupTime: e.target.value })} />}
              </span>
            </Row>
            <Row label="Next copy" hint={`Times use the dashboard time zone (${settings.timezone}).`}>
              <span className="sub">{sched?.nextAt ? (sched.nextAt <= Date.now() + 90_000 ? "Within a minute" : fmtDateTime(sched.nextAt, settings)) : "—"}{sched?.lastAt ? ` · last scheduled copy ${ago(sched.lastAt)}` : ""}</span>
            </Row>
          </>
        )}
        <Row label="Keep the last" hint="Older scheduled copies are removed. Safety copies made before imports, restores and upgrades are kept separately.">
          <select value={settings.backupKeep} onChange={e => void save.save({ backupKeep: Number(e.target.value) })}>{[3, 7, 14, 30, 60, 120].map(n => <option key={n} value={n}>{n} copies</option>)}</select>
        </Row>
        {save.el}
        <Row label="">
          <span className="row wrapme">
            <button className="btn pri" disabled={busy === "make"} onClick={() => void makeCopy()}>{busy === "make" ? "Saving…" : "Save a copy now"}</button>
            <input ref={addRef} type="file" accept=".db,.gz,.tar.gz,application/octet-stream,application/gzip" hidden onChange={e => void upload(e.target.files?.[0])} />
            <button className="btn" disabled={busy === "upload"} onClick={() => addRef.current?.click()}>{busy === "upload" ? "Checking…" : "Add a copy from a file…"}</button>
            <a className="btn" href="/api/backup/complete" download title="The database and every saved icon in one file">Download a Complete backup</a>
          </span>
        </Row>
        {snaps.length === 0 ? <p className="sub">No copies yet.</p> : (
          <div className="rows">{snaps.map(s => (
            <div key={s.name} className="srow">
              <div className="trunc"><b>{s.name}</b><div className="sub">{fmtDateTime(s.ts, settings)} · {bytes(s.size)}{s.auto ? "" : /before-/.test(s.name) ? " · safety copy" : /uploaded/.test(s.name) ? " · added from a file" : " · saved by hand"} {badge(s)}</div></div>
              <span className="row wrapme">
                <button className="btn sm" disabled={busy === s.name} onClick={() => void verify(s.name)}>Verify</button>
                <button className="btn sm" disabled={busy === s.name} onClick={() => void askRestore(s.name)}>Restore…</button>
                <a className="btn sm" href={`/api/backup/snapshots/${s.name}`} download>Download</a>
                <Confirm label="Delete" name={`Delete ${s.name}`} sure="Sure?" onGo={async () => { try { await api.del(`/api/backup/snapshots/${s.name}`); if (report?.name === s.name) setReport(null); load(); } catch (e) { sn.bad(e); } }} />
              </span>
            </div>
          ))}</div>
        )}
        {report && <VerifyView report={report.report} title={report.name} />}
        {restoring && (
          <div className="preview warnbox">
            <b>Restore {restoring.name}?</b>
            <VerifyView report={restoring.report} />
            <p>This replaces everything in Homebase (layout, connections, cameras, accounts, share links, settings and log) with what is in this copy. Anything changed since it was made is lost, except that a safety copy of right now is saved first. Homebase restarts, and you will probably need to sign in again.</p>
            {!restoring.report.ok && <label className="check"><input type="checkbox" checked={restoring.force} onChange={e => setRestoring({ ...restoring, force: e.target.checked })} /> I have read the problems above and still want to restore this copy</label>}
            <span className="row wrapme"><button className="btn pri" disabled={!restoring.report.ok && !restoring.force} onClick={() => void doRestore()}>Restore and restart</button><button className="btn" onClick={() => setRestoring(null)}>Cancel</button></span>
          </div>
        )}
        {sn.el}
      </Section>

      <Section title="Verify a file" hint="Check any database copy (.db), Complete backup (.tar.gz) or Homebase backup (.json) without restoring it, for example one you pulled from your NAS. Nothing is changed.">
        <Row label="Passphrase" hint="Only needed to check the protected section of a JSON backup."><input type="password" autoComplete="off" value={filePass} onChange={e => setFilePass(e.target.value)} placeholder="Optional" /></Row>
        <Row label=""><input ref={verRef} type="file" accept=".db,.gz,.tar.gz,.json,application/json,application/gzip,application/octet-stream" hidden onChange={e => void verifyFile(e.target.files?.[0])} /><button className="btn" disabled={busy === "file"} onClick={() => verRef.current?.click()}>{busy === "file" ? "Checking…" : "Choose a file to verify…"}</button></Row>
        {fileReport && <VerifyView report={fileReport.report} title={fileReport.name} />}
        {vf.el}
      </Section>
    </>
  );
}
